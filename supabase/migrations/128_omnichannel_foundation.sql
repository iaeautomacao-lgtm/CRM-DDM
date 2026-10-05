-- 128 — Fundação do omnichannel (F1/F2/F6).
--
-- 1. clients ............ Cliente da DDM a que cada linha pertence (marca,
--                          filtro e selo no inbox).
-- 2. channels ........... Linhas que não são WhatsApp: Instagram e
--                          Messenger (SMS entra quando o provedor for
--                          escolhido). WhatsApp continua em whatsapp_config
--                          — a bifurcação Meta/WAHA não muda.
-- 3. conversations ...... channel_type ampliado, channel_id, client_id,
--                          SLA (first_response_at, last_customer_message_at)
--                          e trigger de roteamento (equipe + cliente da linha).
-- 4. contacts ........... phone passa a aceitar NULL (contato só de
--                          Instagram/Messenger) + contact_identities (id do
--                          cliente em cada canal) + merge_contact_into().
-- 5. conversation_assignments  Histórico de atribuição/transferência.
-- 6. RLS de agente ...... vê as atribuídas a ele E a fila da equipe
--                          (pendentes sem atendente), para poder assumir.
-- 7. automations.line_ids  Automação por linha (vazio = todas).
--
-- Pré-requisito: 126 e 127 aplicadas. Conferir o schema live antes.

BEGIN;

-- ------------------------------------------------------------------
-- 1. Clientes
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wacrm.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  color text NOT NULL DEFAULT '#6366f1' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, name)
);
ALTER TABLE wacrm.clients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS clients_select ON wacrm.clients;
CREATE POLICY clients_select ON wacrm.clients FOR SELECT TO authenticated
  USING (wacrm.is_account_member(account_id));
DROP POLICY IF EXISTS clients_write ON wacrm.clients;
CREATE POLICY clients_write ON wacrm.clients FOR ALL TO authenticated
  USING (wacrm.is_account_member(account_id, 'admin'))
  WITH CHECK (wacrm.is_account_member(account_id, 'admin'));

ALTER TABLE wacrm.whatsapp_config
  ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES wacrm.clients(id) ON DELETE SET NULL;

-- ------------------------------------------------------------------
-- 2. Canais não-WhatsApp
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wacrm.channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('instagram', 'messenger', 'sms')),
  name text NOT NULL,
  -- Instagram: IG user id (entry.id do webhook). Messenger: Page id.
  external_id text NOT NULL,
  username text,
  avatar_url text,
  -- Token de acesso (AES-256-GCM, src/lib/whatsapp/encryption.ts).
  access_token text NOT NULL,
  token_expires_at timestamptz,
  team_id uuid REFERENCES wacrm.teams(id) ON DELETE SET NULL,
  -- Fluxo receptivo da linha (mesma regra de whatsapp_config.flow_id).
  flow_id uuid REFERENCES wacrm.flows(id) ON DELETE SET NULL,
  client_id uuid REFERENCES wacrm.clients(id) ON DELETE SET NULL,
  habilitado boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'error', 'disconnected')),
  last_error text,
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- O mesmo perfil/página não pode estar ligado a duas contas: o webhook
  -- resolve a conta pelo external_id.
  UNIQUE (type, external_id)
);
-- O token não pode ir ao navegador: sem acesso direto do authenticated;
-- a UI lê pelas rotas /api/channels (service role, sem o token).
ALTER TABLE wacrm.channels ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.channels FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.channels TO service_role;

-- ------------------------------------------------------------------
-- 3. Conversas: canal, cliente, SLA, roteamento
-- ------------------------------------------------------------------
ALTER TABLE wacrm.conversations DROP CONSTRAINT IF EXISTS conversations_channel_type_check;
ALTER TABLE wacrm.conversations ADD CONSTRAINT conversations_channel_type_check
  CHECK (channel_type IN ('whatsapp', 'webchat', 'instagram', 'messenger', 'sms'));
ALTER TABLE wacrm.conversations
  ADD COLUMN IF NOT EXISTS channel_id uuid REFERENCES wacrm.channels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS client_id uuid REFERENCES wacrm.clients(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS first_response_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_customer_message_at timestamptz;

-- Equipe e cliente vêm da linha na criação da conversa. Complementa o
-- trigger da 104 (team_id por config_id) com channel_id e client_id.
CREATE OR REPLACE FUNCTION wacrm.set_conversation_routing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public AS $$
BEGIN
  IF NEW.channel_id IS NOT NULL THEN
    SELECT COALESCE(NEW.team_id, c.team_id), COALESCE(NEW.client_id, c.client_id)
      INTO NEW.team_id, NEW.client_id
      FROM wacrm.channels c WHERE c.id = NEW.channel_id;
  ELSIF NEW.config_id IS NOT NULL AND NEW.client_id IS NULL THEN
    SELECT w.client_id INTO NEW.client_id FROM wacrm.whatsapp_config w WHERE w.id = NEW.config_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_set_conversation_routing ON wacrm.conversations;
CREATE TRIGGER trg_set_conversation_routing
  BEFORE INSERT ON wacrm.conversations
  FOR EACH ROW EXECUTE FUNCTION wacrm.set_conversation_routing();

-- Backfill do cliente nas conversas de WhatsApp existentes (só quando a
-- linha já tiver cliente — nas instalações novas é um no-op).
UPDATE wacrm.conversations cv SET client_id = w.client_id
  FROM wacrm.whatsapp_config w
  WHERE cv.config_id = w.id AND cv.client_id IS NULL AND w.client_id IS NOT NULL;

-- SLA a partir das próprias mensagens, para valer em todos os caminhos
-- (webhooks, inbox, Webchat, fluxos): última mensagem do cliente e
-- primeira resposta de um ATENDENTE humano depois de abrir a conversa.
CREATE OR REPLACE FUNCTION wacrm.track_conversation_sla()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public AS $$
BEGIN
  IF NEW.sender_type = 'customer' THEN
    UPDATE wacrm.conversations SET last_customer_message_at = NEW.created_at
      WHERE id = NEW.conversation_id
        AND (last_customer_message_at IS NULL OR last_customer_message_at < NEW.created_at);
  ELSIF NEW.sender_type = 'agent' AND NEW.sender_id IS NOT NULL THEN
    -- Só conta como resposta depois que o cliente escreveu (conversa
    -- iniciada pelo atendente não vira "respondeu em 0 min").
    UPDATE wacrm.conversations SET first_response_at = NEW.created_at
      WHERE id = NEW.conversation_id AND first_response_at IS NULL
        AND last_customer_message_at IS NOT NULL;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_track_conversation_sla ON wacrm.messages;
CREATE TRIGGER trg_track_conversation_sla
  AFTER INSERT ON wacrm.messages
  FOR EACH ROW EXECUTE FUNCTION wacrm.track_conversation_sla();

-- Lista do inbox paginada no servidor com filtros.
CREATE INDEX IF NOT EXISTS idx_conversations_inbox
  ON wacrm.conversations(account_id, status, last_message_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_inbox_channel
  ON wacrm.conversations(account_id, channel_type, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_inbox_agent
  ON wacrm.conversations(account_id, assigned_agent_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_inbox_team
  ON wacrm.conversations(account_id, team_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_inbox_client
  ON wacrm.conversations(account_id, client_id, last_message_at DESC);

-- ------------------------------------------------------------------
-- 4. Contato multicanal
-- ------------------------------------------------------------------
-- Contato vindo só de Instagram/Messenger não tem telefone. O índice
-- único (account_id, phone_normalized) da 022 aceita vários NULL.
ALTER TABLE wacrm.contacts ALTER COLUMN phone DROP NOT NULL;

CREATE TABLE IF NOT EXISTS wacrm.contact_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES wacrm.contacts(id) ON DELETE CASCADE,
  channel_type text NOT NULL CHECK (channel_type IN ('instagram', 'messenger', 'sms', 'webchat')),
  -- IGSID (Instagram) / PSID (Messenger): o id é por canal/página, então
  -- a linha também entra na chave.
  channel_id uuid REFERENCES wacrm.channels(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  display_name text,
  username text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (account_id, channel_type, channel_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_identities_contact ON wacrm.contact_identities(contact_id);
ALTER TABLE wacrm.contact_identities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_identities_select ON wacrm.contact_identities;
CREATE POLICY contact_identities_select ON wacrm.contact_identities FOR SELECT TO authenticated
  USING (wacrm.is_account_member(account_id));
REVOKE INSERT, UPDATE, DELETE ON wacrm.contact_identities FROM PUBLIC, anon, authenticated;
GRANT SELECT ON wacrm.contact_identities TO authenticated;
GRANT ALL ON wacrm.contact_identities TO service_role;

-- Une p_drop em p_keep (mesmo cliente que chegou por dois canais). Mesmo
-- conjunto de tabelas do merge_duplicate_contacts (022) + as novas.
-- Runs ativos do contato que some são encerrados antes (um run por
-- contato), e telefones/tags/campos que colidiriam ficam com p_keep.
CREATE OR REPLACE FUNCTION wacrm.merge_contact_into(p_keep uuid, p_drop uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public AS $$
DECLARE
  v_account uuid;
  v_name text;
  v_email text;
  v_avatar text;
  v_phone text;
BEGIN
  IF p_keep = p_drop THEN RETURN p_keep; END IF;
  SELECT account_id INTO v_account FROM wacrm.contacts WHERE id = p_keep;
  IF v_account IS NULL OR NOT EXISTS (
    SELECT 1 FROM wacrm.contacts WHERE id = p_drop AND account_id = v_account
  ) THEN
    RAISE EXCEPTION 'contacts must exist in the same account';
  END IF;

  UPDATE wacrm.flow_runs SET status = 'transferred', ended_at = clock_timestamp(), end_reason = 'contact_merged'
    WHERE contact_id = p_drop AND status IN ('active', 'paused_by_agent', 'delayed');
  UPDATE wacrm.flow_runs SET contact_id = p_keep WHERE contact_id = p_drop;
  UPDATE wacrm.conversations SET contact_id = p_keep WHERE contact_id = p_drop;
  UPDATE wacrm.contact_notes SET contact_id = p_keep WHERE contact_id = p_drop;
  UPDATE wacrm.deals SET contact_id = p_keep WHERE contact_id = p_drop;
  UPDATE wacrm.automation_logs SET contact_id = p_keep WHERE contact_id = p_drop;
  UPDATE wacrm.automation_pending_executions SET contact_id = p_keep WHERE contact_id = p_drop;
  UPDATE wacrm.disp_message_queue SET contact_id = p_keep WHERE contact_id = p_drop;
  UPDATE wacrm.webchat_sessions SET status = 'revoked' WHERE contact_id = p_drop AND status = 'active';
  UPDATE wacrm.webchat_sessions SET contact_id = p_keep WHERE contact_id = p_drop;
  UPDATE wacrm.contact_identities SET contact_id = p_keep WHERE contact_id = p_drop;
  UPDATE wacrm.contact_tags t SET contact_id = p_keep WHERE t.contact_id = p_drop
    AND NOT EXISTS (SELECT 1 FROM wacrm.contact_tags s WHERE s.contact_id = p_keep AND s.tag_id = t.tag_id);
  UPDATE wacrm.contact_custom_values v SET contact_id = p_keep WHERE v.contact_id = p_drop
    AND NOT EXISTS (SELECT 1 FROM wacrm.contact_custom_values s WHERE s.contact_id = p_keep AND s.custom_field_id = v.custom_field_id);

  -- Mesmo que o merge_duplicate_contacts (022); a tabela pode não existir
  -- mais no schema live, por isso o guard.
  IF to_regclass('wacrm.broadcast_recipients') IS NOT NULL THEN
    EXECUTE 'UPDATE wacrm.broadcast_recipients SET contact_id = $1 WHERE contact_id = $2'
      USING p_keep, p_drop;
  END IF;

  -- Guarda o que só o outro tinha e apaga ele ANTES de copiar: o telefone
  -- tem índice único (account_id, phone_normalized) e colidiria.
  SELECT name, email, avatar_url, phone INTO v_name, v_email, v_avatar, v_phone
    FROM wacrm.contacts WHERE id = p_drop;

  -- O resto (tags/campos/telefones duplicados) sai com o contato.
  DELETE FROM wacrm.contacts WHERE id = p_drop;

  UPDATE wacrm.contacts SET
    name = COALESCE(NULLIF(name, ''), v_name),
    email = COALESCE(NULLIF(email, ''), v_email),
    avatar_url = COALESCE(avatar_url, v_avatar),
    phone = COALESCE(NULLIF(phone, ''), v_phone),
    updated_at = clock_timestamp()
  WHERE id = p_keep;
  RETURN p_keep;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.merge_contact_into(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.merge_contact_into(uuid, uuid) TO service_role;

-- ------------------------------------------------------------------
-- 5. Histórico de atribuição
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wacrm.conversation_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES wacrm.conversations(id) ON DELETE CASCADE,
  from_agent_id uuid,
  to_agent_id uuid,
  from_team_id uuid,
  to_team_id uuid,
  -- Quem fez a mudança (null = sistema: fluxo, cron de atribuição, IA).
  actor_id uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_conversation_assignments_conv
  ON wacrm.conversation_assignments(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_assignments_agent
  ON wacrm.conversation_assignments(account_id, to_agent_id, created_at DESC);
ALTER TABLE wacrm.conversation_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_assignments_select ON wacrm.conversation_assignments;
CREATE POLICY conversation_assignments_select ON wacrm.conversation_assignments FOR SELECT TO authenticated
  USING (wacrm.is_account_member(account_id));
REVOKE INSERT, UPDATE, DELETE ON wacrm.conversation_assignments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON wacrm.conversation_assignments TO authenticated;
GRANT ALL ON wacrm.conversation_assignments TO service_role;

-- Registra toda mudança de atendente/equipe, venha de onde vier (inbox,
-- fluxo, cron, automação). O motivo é preenchido depois pela rota de
-- transferência (/api/conversations/[id]/transfer).
CREATE OR REPLACE FUNCTION wacrm.log_conversation_assignment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public AS $$
BEGIN
  IF NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id
     OR NEW.team_id IS DISTINCT FROM OLD.team_id THEN
    INSERT INTO wacrm.conversation_assignments
      (account_id, conversation_id, from_agent_id, to_agent_id, from_team_id, to_team_id, actor_id)
    VALUES (NEW.account_id, NEW.id, OLD.assigned_agent_id, NEW.assigned_agent_id,
            OLD.team_id, NEW.team_id, auth.uid());
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_log_conversation_assignment ON wacrm.conversations;
CREATE TRIGGER trg_log_conversation_assignment
  AFTER UPDATE OF assigned_agent_id, team_id ON wacrm.conversations
  FOR EACH ROW EXECUTE FUNCTION wacrm.log_conversation_assignment();

-- ------------------------------------------------------------------
-- 6. RLS do agente: atribuídas + fila da equipe
-- ------------------------------------------------------------------
-- Substitui a v2 (117). Owner/admin/viewer: conta toda (inalterado).
-- Agente: as atribuídas a ele e as SEM atendente da(s) equipe(s) dele,
-- para enxergar a fila e assumir respondendo (send/route.ts atribui a
-- quem responde). Mensagens seguem a conversa (policy da 017).
DROP POLICY IF EXISTS conversations_select ON wacrm.conversations;
CREATE POLICY conversations_select ON wacrm.conversations FOR SELECT USING (
  is_account_member(account_id)
  AND (
    NOT EXISTS (
      SELECT 1 FROM wacrm.profiles p
      WHERE p.user_id = auth.uid() AND p.account_role = 'agent'
    )
    OR assigned_agent_id = auth.uid()
    OR (
      assigned_agent_id IS NULL
      AND status IN ('open', 'pending')
      AND team_id IN (SELECT tm.team_id FROM wacrm.team_members tm WHERE tm.user_id = auth.uid())
    )
  )
);

-- ------------------------------------------------------------------
-- 7. Automação por linha
-- ------------------------------------------------------------------
-- ids de whatsapp_config ou channels; NULL/vazio = todas as linhas.
ALTER TABLE wacrm.automations ADD COLUMN IF NOT EXISTS line_ids uuid[];

NOTIFY pgrst, 'reload schema';
COMMIT;
