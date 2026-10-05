-- ============================================================
-- 131_audit_v2.sql — Auditoria rastreável (quem, de onde, o quê)
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy (depois da 130).
-- Conferir o schema live antes (CLAUDE.md): campaigns não tem CREATE
-- TABLE nos arquivos de migration — as colunas usadas aqui (nome, status,
-- account_id) vêm do código.
--
-- Problemas da 050 que esta migration resolve:
--   - As triggers nunca gravavam usuário/IP (logAuditEvent nem era
--     chamado), então "Usuário" e "IP" ficavam sempre vazios.
--   - Só contatos/conversas, evento genérico (created/updated/deleted),
--     rótulo "Conversa #<uuid>" e IDs crus nos valores.
--
-- Quem fez (wacrm.audit_actor()):
--   - Requisição do navegador direto no PostgREST (papel authenticated):
--     auth.uid() + IP de cf-connecting-ip / x-forwarded-for + user-agent.
--     Headers x-audit-* vindos do navegador são IGNORADOS.
--   - Requisição do NOSSO servidor com o service role: headers x-audit-*
--     montados em src/lib/audit/context.ts a partir do usuário já
--     verificado por getUser(). Só são aceitos quando o JWT é service_role.
--   - Requisição do nosso servidor com a sessão do usuário (cliente SSR):
--     os x-audit-* só valem com x-audit-sig = HMAC-SHA256 do conteúdo com
--     o segredo de wacrm.audit_secrets (o mesmo de AUDIT_HEADER_SECRET no
--     .env) e x-audit-user-id = auth.uid(). Sem assinatura válida, vale o
--     IP que o Supabase viu (o do servidor).
--   - Sem requisição (cron do banco, SQL direto): ator "sistema".
--
-- PASSO MANUAL depois de aplicar: gravar o segredo (o mesmo do .env):
--   INSERT INTO wacrm.audit_secrets (id, header_secret) VALUES (1, '<AUDIT_HEADER_SECRET>')
--   ON CONFLICT (id) DO UPDATE SET header_secret = EXCLUDED.header_secret;
--
-- Idempotente.
-- ============================================================

BEGIN;

SET search_path TO wacrm, public, extensions;

-- ---- colunas novas ----------------------------------------------
ALTER TABLE wacrm.audit_logs
  ADD COLUMN IF NOT EXISTS actor_type text,   -- user | system | webhook | automation | flow | ai | api
  ADD COLUMN IF NOT EXISTS source text,       -- inbox, disparador, webhook_meta, ...
  ADD COLUMN IF NOT EXISTS action text,       -- conversation.assigned, contact.merged, ...
  ADD COLUMN IF NOT EXISTS summary text,      -- frase legível
  ADD COLUMN IF NOT EXISTS user_agent text,
  ADD COLUMN IF NOT EXISTS metadata jsonb;

-- 'action' para eventos que não são CRUD (exportação, início de campanha).
ALTER TABLE wacrm.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_event_type_check;
ALTER TABLE wacrm.audit_logs ADD CONSTRAINT audit_logs_event_type_check
  CHECK (event_type IN ('created', 'updated', 'deleted', 'action'));

CREATE INDEX IF NOT EXISTS audit_logs_account_action
  ON wacrm.audit_logs (account_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_account_resource
  ON wacrm.audit_logs (account_id, resource_id, created_at DESC);

-- IP e user-agent de quem fez são dado sensível: só owner/admin leem.
DROP POLICY IF EXISTS audit_logs_select ON wacrm.audit_logs;
CREATE POLICY audit_logs_select ON wacrm.audit_logs FOR SELECT
  USING (
    is_account_member(account_id)
    AND EXISTS (
      SELECT 1 FROM wacrm.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_id = audit_logs.account_id
        AND p.account_role IN ('owner', 'admin')
    )
  );

-- ---- segredo da assinatura dos headers ---------------------------
CREATE TABLE IF NOT EXISTS wacrm.audit_secrets (
  id int PRIMARY KEY CHECK (id = 1),
  header_secret text NOT NULL CHECK (char_length(header_secret) >= 32)
);
ALTER TABLE wacrm.audit_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.audit_secrets FROM PUBLIC, anon, authenticated, service_role;

-- ---- quem fez -----------------------------------------------------
CREATE OR REPLACE FUNCTION wacrm.audit_actor()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_headers jsonb := nullif(current_setting('request.headers', true), '')::jsonb;
  v_claims  jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_role    text;
  v_user    uuid;
  v_hdr_user text;
  v_ip      text;
  v_ua      text;
  v_type    text;
  v_source  text;
  v_name    text;
  v_secret  text;
  v_signed  boolean := false;
BEGIN
  v_role := v_claims ->> 'role';
  v_hdr_user := nullif(v_headers ->> 'x-audit-user-id', '');
  IF v_hdr_user !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_hdr_user := NULL;
  END IF;

  IF v_role = 'service_role' THEN
    -- Nosso servidor: confia nos headers x-audit-* (src/lib/audit/context.ts).
    v_user := v_hdr_user::uuid;
    v_ip := nullif(v_headers ->> 'x-audit-ip', '');
    v_ua := nullif(v_headers ->> 'x-audit-user-agent', '');
    v_type := coalesce(nullif(v_headers ->> 'x-audit-actor-type', ''),
                       CASE WHEN v_user IS NULL THEN 'system' ELSE 'user' END);
    v_source := nullif(v_headers ->> 'x-audit-source', '');
  ELSIF auth.uid() IS NOT NULL THEN
    v_user := auth.uid();
    -- Headers do app só valem assinados e para o próprio usuário.
    IF v_headers ? 'x-audit-sig' AND v_hdr_user = v_user::text THEN
      SELECT header_secret INTO v_secret FROM wacrm.audit_secrets WHERE id = 1;
      v_signed := v_secret IS NOT NULL AND encode(extensions.hmac(
          concat_ws(E'\n', v_hdr_user, v_headers ->> 'x-audit-ip',
                    v_headers ->> 'x-audit-user-agent', v_headers ->> 'x-audit-source'),
          v_secret, 'sha256'), 'hex') = v_headers ->> 'x-audit-sig';
    END IF;
    IF v_signed THEN
      v_ip := nullif(v_headers ->> 'x-audit-ip', '');
      v_ua := nullif(v_headers ->> 'x-audit-user-agent', '');
      v_source := nullif(v_headers ->> 'x-audit-source', '');
    ELSE
      v_ip := coalesce(
        nullif(v_headers ->> 'cf-connecting-ip', ''),
        nullif(trim(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1)), ''),
        nullif(v_headers ->> 'x-real-ip', '')
      );
      v_ua := nullif(v_headers ->> 'user-agent', '');
    END IF;
    v_type := 'user';
    v_source := coalesce(v_source, 'web');
  ELSE
    v_type := 'system';
    v_source := CASE WHEN v_headers IS NULL THEN 'database' END;
  END IF;

  IF v_user IS NOT NULL THEN
    SELECT nullif(full_name, '') INTO v_name FROM wacrm.profiles WHERE user_id = v_user LIMIT 1;
    IF v_name IS NULL THEN
      SELECT email INTO v_name FROM auth.users WHERE id = v_user;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'user_id', v_user,
    'user_name', v_name,
    'ip', left(v_ip, 64),
    'user_agent', left(v_ua, 300),
    'actor_type', v_type,
    'source', left(v_source, 60)
  );
END;
$$;

-- Ponto único de escrita das triggers.
CREATE OR REPLACE FUNCTION wacrm.audit_write(
  p_account uuid,
  p_event text,
  p_resource_type text,
  p_resource_id uuid,
  p_label text,
  p_action text,
  p_summary text,
  p_changes jsonb DEFAULT NULL,
  p_metadata jsonb DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_actor jsonb := wacrm.audit_actor();
BEGIN
  IF p_account IS NULL OR p_resource_id IS NULL THEN RETURN; END IF;
  INSERT INTO wacrm.audit_logs
    (account_id, event_type, resource_type, resource_id, resource_label,
     user_id, user_name, ip_address, user_agent, actor_type, source,
     action, summary, changes, metadata, created_at)
  VALUES
    (p_account, p_event, p_resource_type, p_resource_id, left(p_label, 200),
     (v_actor ->> 'user_id')::uuid, v_actor ->> 'user_name', v_actor ->> 'ip',
     v_actor ->> 'user_agent', v_actor ->> 'actor_type', v_actor ->> 'source',
     p_action, left(p_summary, 500),
     CASE WHEN p_changes = '{}'::jsonb THEN NULL ELSE p_changes END,
     p_metadata, clock_timestamp());
  -- Sem EXCEPTION aqui de propósito: cada bloco abre uma subtransação e o
  -- guard já existe na trigger que chamou (um só por linha auditada).
END;
$$;
REVOKE ALL ON FUNCTION wacrm.audit_write(uuid, text, text, uuid, text, text, text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.audit_actor() FROM PUBLIC, anon, authenticated;

-- x-audit-note chega com encodeURIComponent (header HTTP só aceita ASCII).
CREATE OR REPLACE FUNCTION wacrm.audit_url_decode(p text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_bytes bytea := ''::bytea;
  i int := 1;
  c text;
BEGIN
  IF p IS NULL THEN RETURN NULL; END IF;
  WHILE i <= length(p) LOOP
    c := substr(p, i, 1);
    IF c = '%' AND i + 2 <= length(p) THEN
      v_bytes := v_bytes || decode(substr(p, i + 1, 2), 'hex');
      i := i + 3;
    ELSE
      v_bytes := v_bytes || convert_to(c, 'UTF8');
      i := i + 1;
    END IF;
  END LOOP;
  RETURN convert_from(v_bytes, 'UTF8');
EXCEPTION WHEN others THEN
  RETURN p;
END;
$$;

-- Nomes legíveis para os valores (atendente, equipe, status).
CREATE OR REPLACE FUNCTION wacrm.audit_agent_name(p_user uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public AS $$
  SELECT CASE WHEN p_user IS NULL THEN NULL
    ELSE coalesce((SELECT nullif(full_name, '') FROM wacrm.profiles WHERE user_id = p_user LIMIT 1), 'Atendente removido') END
$$;
CREATE OR REPLACE FUNCTION wacrm.audit_team_name(p_team uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public AS $$
  SELECT CASE WHEN p_team IS NULL THEN NULL
    ELSE coalesce((SELECT name FROM wacrm.teams WHERE id = p_team), 'Equipe removida') END
$$;
CREATE OR REPLACE FUNCTION wacrm.audit_status_label(p_status text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_status
    WHEN 'open' THEN 'Em atendimento'
    WHEN 'pending' THEN 'Em espera'
    WHEN 'closed' THEN 'Finalizada'
    ELSE p_status END
$$;

-- ============================================================
-- contatos
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.audit_contacts_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_changes jsonb := '{}';
  v_col     text;
  v_old     text;
  v_new     text;
  v_label   text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_label := coalesce(nullif(NEW.name, ''), NEW.phone, 'Contato');
    PERFORM wacrm.audit_write(NEW.account_id, 'created', 'contact', NEW.id, v_label,
      'contact.created', format('Contato %s criado', v_label));
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    FOREACH v_col IN ARRAY ARRAY['name', 'phone', 'email', 'company', 'cpf'] LOOP
      v_old := to_jsonb(OLD) ->> v_col;
      v_new := to_jsonb(NEW) ->> v_col;
      IF v_old IS DISTINCT FROM v_new THEN
        v_changes := v_changes || jsonb_build_object(v_col, jsonb_build_object('before', v_old, 'after', v_new));
      END IF;
    END LOOP;
    IF v_changes <> '{}' THEN
      v_label := coalesce(nullif(NEW.name, ''), NEW.phone, 'Contato');
      PERFORM wacrm.audit_write(NEW.account_id, 'updated', 'contact', NEW.id, v_label,
        'contact.updated',
        format('Contato %s alterado (%s)', v_label,
          (SELECT string_agg(k, ', ') FROM jsonb_object_keys(v_changes) k)),
        v_changes);
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_label := coalesce(nullif(OLD.name, ''), OLD.phone, 'Contato');
    PERFORM wacrm.audit_write(OLD.account_id, 'deleted', 'contact', OLD.id, v_label,
      'contact.deleted', format('Contato %s excluído', v_label), NULL,
      jsonb_build_object('phone', OLD.phone, 'email', OLD.email));
    RETURN OLD;
  END IF;
  RETURN NULL;
EXCEPTION WHEN others THEN
  -- Auditoria nunca derruba a escrita original.
  RAISE WARNING 'audit_contacts_changes falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;

-- ============================================================
-- conversas
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.audit_conversation_label(p_contact uuid, p_channel text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = wacrm, public AS $$
  SELECT format('Conversa com %s (%s)',
    coalesce((SELECT coalesce(nullif(name, ''), phone) FROM wacrm.contacts WHERE id = p_contact), 'contato'),
    CASE coalesce(p_channel, 'whatsapp')
      WHEN 'whatsapp' THEN 'WhatsApp' WHEN 'webchat' THEN 'Webchat'
      WHEN 'instagram' THEN 'Instagram' WHEN 'messenger' THEN 'Messenger'
      ELSE p_channel END)
$$;

CREATE OR REPLACE FUNCTION wacrm.audit_conversations_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_changes jsonb := '{}';
  v_parts   text[] := ARRAY[]::text[];
  v_action  text;
  v_label   text;
  v_meta    jsonb := '{}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_label := wacrm.audit_conversation_label(NEW.contact_id, to_jsonb(NEW) ->> 'channel_type');
    PERFORM wacrm.audit_write(NEW.account_id, 'created', 'conversation', NEW.id, v_label,
      'conversation.created', format('%s iniciada', v_label), NULL,
      jsonb_build_object('contact_id', NEW.contact_id));
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_label := wacrm.audit_conversation_label(OLD.contact_id, to_jsonb(OLD) ->> 'channel_type');
    PERFORM wacrm.audit_write(OLD.account_id, 'deleted', 'conversation', OLD.id, v_label,
      'conversation.deleted', format('%s excluída', v_label), NULL,
      jsonb_build_object('contact_id', OLD.contact_id));
    RETURN OLD;
  END IF;

  -- UPDATE
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    v_changes := v_changes || jsonb_build_object('status', jsonb_build_object(
      'before', wacrm.audit_status_label(OLD.status), 'after', wacrm.audit_status_label(NEW.status)));
    v_parts := v_parts || format('status %s → %s',
      wacrm.audit_status_label(OLD.status), wacrm.audit_status_label(NEW.status));
    v_action := CASE
      WHEN NEW.status = 'closed' THEN 'conversation.closed'
      WHEN OLD.status = 'closed' THEN 'conversation.reopened'
      ELSE 'conversation.status_changed' END;
  END IF;
  IF OLD.assigned_agent_id IS DISTINCT FROM NEW.assigned_agent_id THEN
    v_changes := v_changes || jsonb_build_object('assigned_agent_id', jsonb_build_object(
      'before', wacrm.audit_agent_name(OLD.assigned_agent_id),
      'after', wacrm.audit_agent_name(NEW.assigned_agent_id)));
    v_parts := v_parts || CASE
      WHEN NEW.assigned_agent_id IS NULL THEN format('atendente %s removido', wacrm.audit_agent_name(OLD.assigned_agent_id))
      WHEN OLD.assigned_agent_id IS NULL THEN format('atribuída a %s', wacrm.audit_agent_name(NEW.assigned_agent_id))
      ELSE format('transferida de %s para %s', wacrm.audit_agent_name(OLD.assigned_agent_id), wacrm.audit_agent_name(NEW.assigned_agent_id))
    END;
    v_meta := v_meta || jsonb_build_object('from_agent_id', OLD.assigned_agent_id, 'to_agent_id', NEW.assigned_agent_id);
    IF v_action IS NULL OR v_action = 'conversation.status_changed' THEN
      v_action := CASE WHEN NEW.assigned_agent_id IS NULL THEN 'conversation.unassigned' ELSE 'conversation.assigned' END;
    END IF;
  END IF;
  IF OLD.team_id IS DISTINCT FROM NEW.team_id THEN
    v_changes := v_changes || jsonb_build_object('team_id', jsonb_build_object(
      'before', wacrm.audit_team_name(OLD.team_id), 'after', wacrm.audit_team_name(NEW.team_id)));
    v_parts := v_parts || format('equipe %s → %s',
      coalesce(wacrm.audit_team_name(OLD.team_id), 'nenhuma'), coalesce(wacrm.audit_team_name(NEW.team_id), 'nenhuma'));
    v_meta := v_meta || jsonb_build_object('from_team_id', OLD.team_id, 'to_team_id', NEW.team_id);
    v_action := coalesce(v_action, 'conversation.team_changed');
  END IF;
  IF OLD.waha_session IS DISTINCT FROM NEW.waha_session THEN
    v_changes := v_changes || jsonb_build_object('waha_session', jsonb_build_object('before', OLD.waha_session, 'after', NEW.waha_session));
    v_parts := v_parts || format('sessão %s → %s', coalesce(OLD.waha_session, '-'), coalesce(NEW.waha_session, '-'));
    v_action := coalesce(v_action, 'conversation.updated');
  END IF;
  IF (to_jsonb(OLD) ->> 'outcome_tag_id') IS DISTINCT FROM (to_jsonb(NEW) ->> 'outcome_tag_id') THEN
    v_changes := v_changes || jsonb_build_object('outcome_tag_id', jsonb_build_object(
      'before', (SELECT name FROM wacrm.tags WHERE id = (to_jsonb(OLD) ->> 'outcome_tag_id')::uuid),
      'after', (SELECT name FROM wacrm.tags WHERE id = (to_jsonb(NEW) ->> 'outcome_tag_id')::uuid)));
    v_parts := v_parts || format('tabulação %s', coalesce(
      (SELECT name FROM wacrm.tags WHERE id = (to_jsonb(NEW) ->> 'outcome_tag_id')::uuid), 'removida'));
    v_action := coalesce(v_action, 'conversation.updated');
  END IF;

  IF v_changes <> '{}' THEN
    v_label := wacrm.audit_conversation_label(NEW.contact_id, to_jsonb(NEW) ->> 'channel_type');
    -- Motivo/observação enviados pelo servidor (ex.: transferência).
    v_meta := v_meta || jsonb_strip_nulls(jsonb_build_object('reason', wacrm.audit_url_decode(
      nullif(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-audit-note', ''))));
    PERFORM wacrm.audit_write(NEW.account_id, 'updated', 'conversation', NEW.id, v_label,
      v_action, format('%s: %s', v_label, array_to_string(v_parts, '; ')),
      v_changes, CASE WHEN v_meta = '{}' THEN NULL ELSE v_meta END);
  END IF;
  RETURN NEW;
EXCEPTION WHEN others THEN
  -- Auditoria nunca derruba a escrita original.
  RAISE WARNING 'audit_conversations_changes falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_conversations ON wacrm.conversations;
CREATE TRIGGER trg_audit_conversations
  AFTER INSERT OR UPDATE OR DELETE ON wacrm.conversations
  FOR EACH ROW EXECUTE FUNCTION wacrm.audit_conversations_changes();

-- ============================================================
-- Genérica: configurações (campanhas, fluxos, automações, linhas...)
-- TG_ARGV: [0] resource_type, [1] rótulo (pt-BR), [2] coluna do nome,
--          [3] colunas acompanhadas separadas por vírgula.
-- Só as colunas listadas entram no diff: tokens/segredos e contadores
-- (métricas de campanha, execution_count) ficam de fora de propósito.
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.audit_generic_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_type    text := TG_ARGV[0];
  v_noun    text := TG_ARGV[1];
  v_name    text := TG_ARGV[2];
  v_cols    text[] := string_to_array(TG_ARGV[3], ',');
  v_old     jsonb;
  v_new     jsonb;
  v_row     jsonb;
  v_changes jsonb := '{}';
  v_col     text;
  v_label   text;
  v_action  text;
BEGIN
  v_old := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
  v_new := CASE WHEN TG_OP IN ('UPDATE', 'INSERT') THEN to_jsonb(NEW) END;
  v_row := coalesce(v_new, v_old);
  v_label := coalesce(nullif(v_row ->> v_name, ''), v_noun);

  IF TG_OP = 'UPDATE' THEN
    FOREACH v_col IN ARRAY v_cols LOOP
      IF (v_old -> v_col) IS DISTINCT FROM (v_new -> v_col) THEN
        v_changes := v_changes || jsonb_build_object(v_col, jsonb_build_object(
          'before', v_old -> v_col, 'after', v_new -> v_col));
      END IF;
    END LOOP;
    IF v_changes = '{}' THEN RETURN NEW; END IF;
    v_action := v_type || CASE
      WHEN v_changes ? 'status' THEN '.status_changed'
      WHEN v_changes ? 'is_active' OR v_changes ? 'habilitado' THEN '.toggled'
      ELSE '.updated' END;
  END IF;

  PERFORM wacrm.audit_write(
    (v_row ->> 'account_id')::uuid,
    CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'DELETE' THEN 'deleted' ELSE 'updated' END,
    v_type,
    (v_row ->> 'id')::uuid,
    v_label,
    coalesce(v_action, v_type || CASE TG_OP WHEN 'INSERT' THEN '.created' ELSE '.deleted' END),
    CASE TG_OP
      WHEN 'INSERT' THEN format('%s %s criado(a)', v_noun, v_label)
      WHEN 'DELETE' THEN format('%s %s excluído(a)', v_noun, v_label)
      ELSE format('%s %s alterado(a) (%s)', v_noun, v_label,
        (SELECT string_agg(k, ', ') FROM jsonb_object_keys(v_changes) k))
    END,
    CASE WHEN TG_OP = 'UPDATE' THEN v_changes END
  );
  RETURN coalesce(NEW, OLD);
EXCEPTION WHEN others THEN
  -- Auditoria nunca derruba a escrita original.
  RAISE WARNING 'audit_generic_changes falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.audit_url_decode(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.audit_agent_name(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.audit_team_name(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.audit_status_label(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.audit_conversation_label(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.audit_contacts_changes() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.audit_conversations_changes() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.audit_generic_changes() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('campaigns',         'campaign',     'Campanha',  'nome',
       'nome,status,descricao,session_ids,tags_filtro,agendamento,janela_inicio,janela_fim,intervalo_min,intervalo_max,batch_size,webchat_enabled'),
    ('flows',             'flow',         'Fluxo',     'name',
       'name,status,trigger_type,trigger_config,entry_node_id,description'),
    ('automations',       'automation',   'Automação', 'name',
       'name,is_active,trigger_type,trigger_config,description,line_ids'),
    ('whatsapp_config',   'whatsapp_line','Linha WhatsApp', 'display_phone_number',
       'display_phone_number,provider,waha_session,habilitado,team_id,client_id,flow_id,phone_number_id'),
    ('channels',          'channel',      'Canal',     'name',
       'name,type,username,habilitado,status,team_id,client_id,flow_id'),
    ('teams',             'team',         'Equipe',    'name',
       'name,description'),
    ('clients',           'client',       'Cliente',   'name',
       'name,color'),
    ('tags',              'tag',          'Etiqueta',  'name',
       'name,color'),
    ('message_templates', 'template',     'Template',  'name',
       'name,status,category,language,body_text'),
    ('profiles',          'member',       'Membro',    'full_name',
       'full_name,account_role,max_simultaneous_chats')
  ) AS v(tbl, rtype, noun, name_col, cols)
  LOOP
    IF to_regclass('wacrm.' || t.tbl) IS NULL THEN
      RAISE NOTICE 'audit: tabela wacrm.% não existe, pulando', t.tbl;
      CONTINUE;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%1$s ON wacrm.%1$I', t.tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON wacrm.%1$I
         FOR EACH ROW EXECUTE FUNCTION wacrm.audit_generic_changes(%2$L, %3$L, %4$L, %5$L)',
      t.tbl, t.rtype, t.noun, t.name_col, t.cols);
  END LOOP;
END;
$$;

-- ============================================================
-- Etiquetas do contato (contact_tags) e membros de equipe (team_members):
-- tabelas sem account_id/nome próprios — o evento vai para o contato /
-- equipe dono.
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.audit_contact_tags_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_row     record := coalesce(NEW, OLD);
  v_account uuid;
  v_label   text;
  v_tag     text;
BEGIN
  SELECT account_id, coalesce(nullif(name, ''), phone, 'Contato') INTO v_account, v_label
    FROM wacrm.contacts WHERE id = v_row.contact_id;
  -- Contato sendo excluído em cascata: o evento de exclusão já basta.
  IF v_account IS NULL THEN RETURN NULL; END IF;
  SELECT name INTO v_tag FROM wacrm.tags WHERE id = v_row.tag_id;
  PERFORM wacrm.audit_write(v_account, 'updated', 'contact', v_row.contact_id, v_label,
    CASE TG_OP WHEN 'INSERT' THEN 'contact.tag_added' ELSE 'contact.tag_removed' END,
    format('Etiqueta %s %s em %s', coalesce(v_tag, '?'),
      CASE TG_OP WHEN 'INSERT' THEN 'adicionada' ELSE 'removida' END, v_label),
    NULL, jsonb_build_object('tag_id', v_row.tag_id, 'tag', v_tag));
  RETURN NULL;
EXCEPTION WHEN others THEN
  -- Auditoria nunca derruba a escrita original.
  RAISE WARNING 'audit_contact_tags_changes falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_audit_contact_tags ON wacrm.contact_tags;
CREATE TRIGGER trg_audit_contact_tags
  AFTER INSERT OR DELETE ON wacrm.contact_tags
  FOR EACH ROW EXECUTE FUNCTION wacrm.audit_contact_tags_changes();

CREATE OR REPLACE FUNCTION wacrm.audit_team_members_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_row     record := coalesce(NEW, OLD);
  v_account uuid;
  v_team    text;
  v_member  text := wacrm.audit_agent_name(v_row.user_id);
BEGIN
  SELECT account_id, name INTO v_account, v_team FROM wacrm.teams WHERE id = v_row.team_id;
  IF v_account IS NULL THEN RETURN NULL; END IF;
  PERFORM wacrm.audit_write(v_account, 'updated', 'team', v_row.team_id, v_team,
    CASE TG_OP WHEN 'INSERT' THEN 'team.member_added' ELSE 'team.member_removed' END,
    format('%s %s da equipe %s', v_member,
      CASE TG_OP WHEN 'INSERT' THEN 'adicionado(a)' ELSE 'removido(a)' END, v_team),
    NULL, jsonb_build_object('user_id', v_row.user_id));
  RETURN NULL;
EXCEPTION WHEN others THEN
  -- Auditoria nunca derruba a escrita original.
  RAISE WARNING 'audit_team_members_changes falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.audit_contact_tags_changes() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_audit_team_members ON wacrm.team_members;
CREATE TRIGGER trg_audit_team_members
  AFTER INSERT OR DELETE ON wacrm.team_members
  FOR EACH ROW EXECUTE FUNCTION wacrm.audit_team_members_changes();
REVOKE ALL ON FUNCTION wacrm.audit_team_members_changes() FROM PUBLIC, anon, authenticated;

COMMIT;
