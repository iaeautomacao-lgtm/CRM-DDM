-- ============================================================
-- 382_seguranca_carteira_mfa_reserva.sql   (revisão de segurança de 16/10: achados M2, M3, M5 e M6)
--
-- O QUE FAZ (nada de tabela nova; só funções, triggers e uma limpeza pontual):
--   M2  Carteira (372): contacts.owner_user_id só muda por quem tem permissão de gestão e só aponta para atendente ATIVO DA MESMA CONTA.
--       Trigger BEFORE INSERT/UPDATE em wacrm.contacts (wacrm.guard_contact_owner_write):
--         • sessão do navegador (anon/authenticated) precisa ser admin+ da conta E ter contacts.edit; o operador comum recebe 42501;
--         • para QUALQUER escritor (inclusive service_role): o dono precisa ser membro da conta do contato, ativo (311) e com papel
--           owner/admin/supervisor/agent — a mesma regra de validateAssignee da API. Outra conta, desativado ou viewer = 23514.
--         • tirar o dono (NULL) é uma mudança de dono: mesma permissão. A cascata ON DELETE SET NULL da FK (executa como dono da tabela) passa.
--       A permissão exigida (admin+ e contacts.edit) usa o que já existe; não há permissão própria da carteira. PERGUNTA ao dono: criar
--       "contacts.assign_owner" no catálogo? (exige mudar src/lib/auth/permissions.ts e as migrations de papéis; fora desta migration.)
--   M3  Painel de IA (375): wacrm.dashboard_ai_snapshot_read() passa a exigir wacrm.mfa_ok() (310). Antes, por ser SECURITY DEFINER, uma sessão
--       aal1 de quem tem TOTP lia o resumo da conta inteira direto pelo PostgREST. CREATE OR REPLACE, mesma assinatura e mesmos grants.
--   M5  Reserva do @operador (376): quando o operador reservado é DESATIVADO, deixa de ser operador (account_role ≠ agent) ou fica SEM APELIDO
--       (ou o perfil é apagado), as conversas reservadas a ele voltam para a fila (requested_agent_id = NULL; status, equipe e updated_at
--       ficam como estão, então o cron de reatribuição as pega na rodada seguinte). Trigger em wacrm.profiles
--       (wacrm.release_mention_reservations, SECURITY DEFINER para o guard da 376 reconhecer o servidor). Também libera, uma vez, as reservas
--       que já estão órfãs por esses 3 motivos. NÃO há expiração por tempo (pausa longa): é pergunta ao dono, nada foi inventado aqui.
--   M6  RPC route_conversation_to_mentioned_agent (376): além de fluxo 'active', encerra também fluxo 'delayed' (senão ele acordava depois
--       e mandava mensagem automática a quem espera o operador). CREATE OR REPLACE, mesma assinatura e mesmos grants. (A parte de código do
--       M6, o guarda requested_agent_id IS NULL nas atribuições automáticas, é do app, não do banco.)
--
-- PRÉ-CHECK (aborta sem alterar nada se faltar algo):
--   SELECT to_regclass('wacrm.contacts'), to_regclass('wacrm.profiles'), to_regclass('wacrm.conversations'), to_regclass('wacrm.flow_runs');   -- não nulos
--   SELECT to_regprocedure('wacrm.dashboard_ai_snapshot_read()'), to_regprocedure('wacrm.mfa_ok()'), to_regprocedure('wacrm.has_perm(text)'),
--          to_regprocedure('wacrm.route_conversation_to_mentioned_agent(uuid,uuid,text)');                                                   -- não nulos
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'wacrm' AND
--     (table_name, column_name) IN (('contacts','owner_user_id'), ('conversations','requested_agent_id'), ('profiles','mention_alias'), ('profiles','deactivated_at'));   -- 4 linhas
--
-- VERIFICAÇÃO PÓS-APLICAÇÃO:
--   SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_guard_contact_owner_write', 'trg_release_mention_reservations_upd', 'trg_release_mention_reservations_del') AND NOT tgisinternal;   -- 3 linhas
--   SELECT pg_get_functiondef('wacrm.dashboard_ai_snapshot_read()'::regprocedure) LIKE '%mfa_ok%';   -- true
--   SELECT pg_get_functiondef('wacrm.route_conversation_to_mentioned_agent(uuid,uuid,text)'::regprocedure) LIKE '%delayed%';   -- true
--
-- ORDEM: depende das migrations 310 (mfa_ok), 311 (deactivated_at), 372 (owner_user_id), 375 e 376. ANTES ou depois do deploy do app (o código
--   do M6 tolera a coluna requested_agent_id ausente). Idempotente. Tem lock_timeout de 5 s: se uma tabela estiver ocupada, aborta limpo; rode de novo.
--
-- ROLLBACK (testado em PGlite por src/lib/security/seguranca-382.sql.test.ts, que executa exatamente as linhas abaixo):
-- ROLLBACK-INICIO
--   BEGIN;
--   SET LOCAL lock_timeout = '5s';
--   DROP TRIGGER IF EXISTS trg_guard_contact_owner_write ON wacrm.contacts;
--   DROP FUNCTION IF EXISTS wacrm.guard_contact_owner_write();
--   DROP TRIGGER IF EXISTS trg_release_mention_reservations_upd ON wacrm.profiles;
--   DROP TRIGGER IF EXISTS trg_release_mention_reservations_del ON wacrm.profiles;
--   DROP FUNCTION IF EXISTS wacrm.release_mention_reservations();
--   CREATE OR REPLACE FUNCTION wacrm.dashboard_ai_snapshot_read()
--   RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
--   AS $fn$
--     SELECT s.data
--       FROM wacrm.dashboard_ai_snapshot s
--      WHERE s.account_id = (SELECT wacrm.current_account_id())
--        AND s.refreshed_at > now() - interval '30 minutes'
--        AND wacrm.is_account_member(s.account_id, 'admin')
--        AND (SELECT wacrm.has_perm('pipelines.view'))
--   $fn$;
--   CREATE OR REPLACE FUNCTION wacrm.route_conversation_to_mentioned_agent(p_account_id uuid, p_conversation_id uuid, p_alias text)
--   RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
--   AS $fn$
--   DECLARE
--     v_agent_id uuid; v_status text; v_assigned_agent_id uuid; v_current_team_id uuid; v_target_team_id uuid;
--   BEGIN
--     IF p_alias IS NULL OR p_alias !~ '^[a-z_][a-z0-9_]{1,31}$' THEN RETURN NULL; END IF;
--     SELECT p.user_id INTO v_agent_id FROM wacrm.profiles p
--      WHERE p.account_id = p_account_id AND p.account_role = 'agent'::wacrm.account_role_enum AND p.mention_alias = p_alias
--        AND (to_jsonb(p) ->> 'deactivated_at') IS NULL
--      LIMIT 1;
--     IF v_agent_id IS NULL THEN RETURN NULL; END IF;
--     SELECT c.status, c.assigned_agent_id, c.team_id INTO v_status, v_assigned_agent_id, v_current_team_id
--       FROM wacrm.conversations c WHERE c.account_id = p_account_id AND c.id = p_conversation_id FOR UPDATE;
--     IF NOT FOUND OR v_status = 'closed' OR v_assigned_agent_id IS NOT NULL THEN RETURN NULL; END IF;
--     SELECT tm.team_id INTO v_target_team_id FROM wacrm.team_members tm
--       JOIN wacrm.teams t ON t.id = tm.team_id AND t.account_id = p_account_id
--      WHERE tm.user_id = v_agent_id
--      ORDER BY CASE WHEN tm.team_id = v_current_team_id THEN 0 ELSE 1 END, tm.created_at, tm.team_id
--      LIMIT 1;
--     UPDATE wacrm.conversations SET status = 'pending', assigned_agent_id = NULL, requested_agent_id = v_agent_id,
--            team_id = v_target_team_id, updated_at = now()
--      WHERE account_id = p_account_id AND id = p_conversation_id;
--     UPDATE wacrm.flow_runs SET status = 'handed_off', end_reason = 'agent_mention', ended_at = now()
--      WHERE account_id = p_account_id AND conversation_id = p_conversation_id AND status = 'active';
--     RETURN v_agent_id;
--   END;
--   $fn$;
--   REVOKE ALL ON FUNCTION wacrm.dashboard_ai_snapshot_read() FROM PUBLIC, anon;
--   GRANT EXECUTE ON FUNCTION wacrm.dashboard_ai_snapshot_read() TO authenticated, service_role;
--   REVOKE ALL ON FUNCTION wacrm.route_conversation_to_mentioned_agent(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
--   GRANT EXECUTE ON FUNCTION wacrm.route_conversation_to_mentioned_agent(uuid, uuid, text) TO service_role;
--   DELETE FROM wacrm.schema_migrations WHERE version = '382_seguranca_carteira_mfa_reserva';
--   COMMIT;
--   NOTIFY pgrst, 'reload schema';
-- ROLLBACK-FIM
-- (As reservas já liberadas pelo M5 não voltam: o rollback não recria reserva, e isso é o certo.)
-- ============================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF to_regclass('wacrm.contacts') IS NULL OR to_regclass('wacrm.profiles') IS NULL
     OR to_regclass('wacrm.conversations') IS NULL OR to_regclass('wacrm.flow_runs') IS NULL THEN
    RAISE EXCEPTION '382: faltam contacts/profiles/conversations/flow_runs em wacrm — confira o schema vivo';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'wacrm' AND
        (table_name, column_name) IN (('contacts', 'owner_user_id'), ('conversations', 'requested_agent_id'),
                                      ('profiles', 'mention_alias'), ('profiles', 'deactivated_at'))) <> 4 THEN
    RAISE EXCEPTION '382: faltam colunas (contacts.owner_user_id da 372, conversations.requested_agent_id e profiles.mention_alias da 376, profiles.deactivated_at da 311)';
  END IF;
  IF to_regprocedure('wacrm.dashboard_ai_snapshot_read()') IS NULL THEN
    RAISE EXCEPTION '382: falta wacrm.dashboard_ai_snapshot_read() (migration 375)';
  END IF;
  IF to_regprocedure('wacrm.mfa_ok()') IS NULL THEN
    RAISE EXCEPTION '382: falta wacrm.mfa_ok() (migration 310)';
  END IF;
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '382: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  IF to_regprocedure('wacrm.route_conversation_to_mentioned_agent(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION '382: falta wacrm.route_conversation_to_mentioned_agent(uuid,uuid,text) (migration 376)';
  END IF;
  -- is_account_member tem 2º argumento opcional (account_role_enum): confere por nome, como a 376.
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'wacrm' AND p.proname = 'is_account_member') THEN
    RAISE EXCEPTION '382: falta wacrm.is_account_member';
  END IF;
END $$;

-- ---------------------------------------------------------------- M2: dono da carteira
CREATE OR REPLACE FUNCTION wacrm.guard_contact_owner_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- Sem mudança de dono (inclui INSERT sem dono): nada a conferir.
  IF TG_OP = 'UPDATE' AND NEW.owner_user_id IS NOT DISTINCT FROM OLD.owner_user_id THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' AND NEW.owner_user_id IS NULL THEN RETURN NEW; END IF;

  -- Sessão do navegador: a carteira é de gestão (admin+ com contacts.edit). Servidor (service_role) e a cascata da FK não passam por aqui.
  IF current_user IN ('anon', 'authenticated') THEN
    IF NOT (wacrm.is_account_member(NEW.account_id, 'admin'::wacrm.account_role_enum) AND (SELECT wacrm.has_perm('contacts.edit'))) THEN
      RAISE EXCEPTION 'contact owner is managed by administrators' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Para todo mundo: o dono é atendente ativo da MESMA conta (mesma regra de validateAssignee da API).
  IF NEW.owner_user_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM wacrm.profiles p
     WHERE p.user_id = NEW.owner_user_id
       AND p.account_id = NEW.account_id
       AND p.account_role IN ('owner', 'admin', 'supervisor', 'agent')
       AND p.deactivated_at IS NULL
  ) THEN
    RAISE EXCEPTION 'contact owner must be an active attendant of the same account' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.guard_contact_owner_write() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_guard_contact_owner_write ON wacrm.contacts;
CREATE TRIGGER trg_guard_contact_owner_write
  BEFORE INSERT OR UPDATE OF owner_user_id ON wacrm.contacts
  FOR EACH ROW EXECUTE FUNCTION wacrm.guard_contact_owner_write();

-- ---------------------------------------------------------------- M3: resumo do painel exige 2FA
CREATE OR REPLACE FUNCTION wacrm.dashboard_ai_snapshot_read()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT s.data
    FROM wacrm.dashboard_ai_snapshot s
   WHERE s.account_id = (SELECT wacrm.current_account_id())
     AND s.refreshed_at > now() - interval '30 minutes'
     AND wacrm.is_account_member(s.account_id, 'admin')
     AND (SELECT wacrm.has_perm('pipelines.view'))
     -- 2FA (310): a função é DEFINER e passa por cima da policy mfa_aal2_required da tabela; a checagem tem de estar aqui.
     AND (SELECT wacrm.mfa_ok())
$$;
REVOKE ALL ON FUNCTION wacrm.dashboard_ai_snapshot_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.dashboard_ai_snapshot_read() TO authenticated, service_role;

-- ---------------------------------------------------------------- M5: reserva do @operador some com o operador
CREATE OR REPLACE FUNCTION wacrm.release_mention_reservations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- Volta para a fila: só zera a reserva (status, equipe e updated_at ficam; o cron de reatribuição as pega).
  UPDATE wacrm.conversations
     SET requested_agent_id = NULL
   WHERE account_id = OLD.account_id AND requested_agent_id = OLD.user_id;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.release_mention_reservations() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_release_mention_reservations_upd ON wacrm.profiles;
CREATE TRIGGER trg_release_mention_reservations_upd
  AFTER UPDATE OF deactivated_at, account_role, mention_alias ON wacrm.profiles
  FOR EACH ROW
  WHEN (
    (NEW.deactivated_at IS NOT NULL AND OLD.deactivated_at IS NULL)
    OR (NEW.account_role IS DISTINCT FROM OLD.account_role AND NEW.account_role IS DISTINCT FROM 'agent'::wacrm.account_role_enum)
    OR (OLD.mention_alias IS NOT NULL AND NEW.mention_alias IS NULL)
  )
  EXECUTE FUNCTION wacrm.release_mention_reservations();

DROP TRIGGER IF EXISTS trg_release_mention_reservations_del ON wacrm.profiles;
CREATE TRIGGER trg_release_mention_reservations_del
  AFTER DELETE ON wacrm.profiles
  FOR EACH ROW EXECUTE FUNCTION wacrm.release_mention_reservations();

-- Limpeza única das reservas que JÁ estão órfãs pelos mesmos 3 motivos objetivos (antes desta migration nada as liberava).
UPDATE wacrm.conversations c
   SET requested_agent_id = NULL
 WHERE c.requested_agent_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM wacrm.profiles p
      WHERE p.user_id = c.requested_agent_id
        AND p.account_id = c.account_id
        AND p.account_role = 'agent'::wacrm.account_role_enum
        AND p.deactivated_at IS NULL
        AND p.mention_alias IS NOT NULL
   );

-- ---------------------------------------------------------------- M6: a RPC da 376 encerra também o fluxo 'delayed'
CREATE OR REPLACE FUNCTION wacrm.route_conversation_to_mentioned_agent(
  p_account_id uuid,
  p_conversation_id uuid,
  p_alias text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_agent_id uuid;
  v_status text;
  v_assigned_agent_id uuid;
  v_current_team_id uuid;
  v_target_team_id uuid;
BEGIN
  IF p_alias IS NULL OR p_alias !~ '^[a-z_][a-z0-9_]{1,31}$' THEN
    RETURN NULL;
  END IF;

  SELECT p.user_id INTO v_agent_id
  FROM wacrm.profiles p
  WHERE p.account_id = p_account_id
    AND p.account_role = 'agent'::wacrm.account_role_enum
    AND p.mention_alias = p_alias
    AND (to_jsonb(p) ->> 'deactivated_at') IS NULL
  LIMIT 1;
  IF v_agent_id IS NULL THEN RETURN NULL; END IF;

  SELECT c.status, c.assigned_agent_id, c.team_id
    INTO v_status, v_assigned_agent_id, v_current_team_id
  FROM wacrm.conversations c
  WHERE c.account_id = p_account_id AND c.id = p_conversation_id
  FOR UPDATE;
  IF NOT FOUND OR v_status = 'closed' OR v_assigned_agent_id IS NOT NULL THEN
    RETURN NULL;
  END IF;

  SELECT tm.team_id INTO v_target_team_id
  FROM wacrm.team_members tm
  JOIN wacrm.teams t ON t.id = tm.team_id AND t.account_id = p_account_id
  WHERE tm.user_id = v_agent_id
  ORDER BY CASE WHEN tm.team_id = v_current_team_id THEN 0 ELSE 1 END,
           tm.created_at, tm.team_id
  LIMIT 1;

  UPDATE wacrm.conversations
  SET status = 'pending',
      assigned_agent_id = NULL,
      requested_agent_id = v_agent_id,
      team_id = v_target_team_id,
      updated_at = now()
  WHERE account_id = p_account_id AND id = p_conversation_id;

  -- 'delayed' (058) também: um fluxo em espera acordaria depois e mandaria mensagem automática a quem aguarda o operador.
  UPDATE wacrm.flow_runs
  SET status = 'handed_off', end_reason = 'agent_mention', ended_at = now()
  WHERE account_id = p_account_id AND conversation_id = p_conversation_id
    AND status IN ('active', 'delayed');

  RETURN v_agent_id;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.route_conversation_to_mentioned_agent(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.route_conversation_to_mentioned_agent(uuid, uuid, text)
  TO service_role;

DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version)
    VALUES ('382_seguranca_carteira_mfa_reserva') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
