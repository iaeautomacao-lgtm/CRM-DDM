-- ============================================================
-- 373_webhook_conversation_events.sql   (API pública Onda 2 — webhooks de conversa)
--
-- O QUE FAZ: dois eventos de saída assinados, só para quem assinou o tipo, por trigger (pega QUALQUER origem: cliente que escreve, campanha, API,
-- fluxo, IA, painel), na fila de webhooks que já existe (assinatura, retry, replay, limite por endpoint da 360):
--   conversation.opened    uma conversa nasceu (INSERT em wacrm.conversations): conversation_id, contact_id, phone, channel (channel_type), status,
--                          team_id, assignee_id, config_id (canal), opened_at.
--   conversation.assigned  mudou o atendente e/ou a equipe (INSERT em wacrm.conversation_assignments, gravado por log_conversation_assignment da 128):
--                          conversation_id, contact_id, from/to agent, from/to team, actor {type, user_id, source}, at. O ator vem de actor_id da linha ou,
--                          se vazio (escrita pelo servidor), de wacrm.audit_actor() da mesma requisição (api, user, flow, ai, system…); o MOTIVO fica só no
--                          histórico de atribuição (é preenchido depois da linha nascer).
--   Só trabalha se a conta tem endpoint ativo assinando o tipo (1 consulta indexada por linha; sem assinatura, custo desprezível). À prova de falha:
--   EXCEPTION → WARNING, NUNCA derruba a abertura da conversa nem a atribuição. `event_id` determinístico (conversa; linha do histórico):
--   reemitir é seguro (idempotente por endpoint).
-- DADO PESSOAL: telefone do contato (como em message.received); nunca CPF nem texto de mensagem.
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.conversations'), to_regclass('wacrm.conversation_assignments'), to_regclass('wacrm.contacts');          -- não nulos
--   SELECT to_regprocedure('wacrm.enqueue_webhook_event(uuid, text, uuid, jsonb)'), to_regprocedure('wacrm.webhook_endpoint_listens(uuid, text)');  -- existem (204)
--   SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'audit_actor';   -- ≥ 1 (131; tolera ausência)
--   SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_webhook_conversation_opened', 'trg_webhook_conversation_assigned') AND NOT tgisinternal;  -- 0 linhas na 1ª vez
-- VERIFICAÇÃO (depois): as mesmas 2 linhas de pg_trigger.
-- ORDEM: depois da 204 e da 128; antes ou depois do deploy (sem ela só faltam os eventos). Idempotente.
-- ROLLBACK:
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_webhook_conversation_opened ON wacrm.conversations;
--   DROP TRIGGER IF EXISTS trg_webhook_conversation_assigned ON wacrm.conversation_assignments;
--   DROP FUNCTION IF EXISTS wacrm.webhook_on_conversation_opened();
--   DROP FUNCTION IF EXISTS wacrm.webhook_on_conversation_assigned();
--   DELETE FROM wacrm.schema_migrations WHERE version = '373_webhook_conversation_events';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.conversations') IS NULL OR to_regclass('wacrm.conversation_assignments') IS NULL OR to_regclass('wacrm.contacts') IS NULL THEN
    RAISE EXCEPTION '373: faltam wacrm.conversations / conversation_assignments / contacts — confira o schema vivo';
  END IF;
  IF to_regprocedure('wacrm.enqueue_webhook_event(uuid, text, uuid, jsonb)') IS NULL
     OR to_regprocedure('wacrm.webhook_endpoint_listens(uuid, text)') IS NULL THEN
    RAISE EXCEPTION '373: faltam as funções de webhook da migration 204 — nada foi alterado';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.webhook_on_conversation_opened()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_row jsonb := to_jsonb(NEW);
  v_phone text;
BEGIN
  IF NEW.account_id IS NULL OR NOT wacrm.webhook_endpoint_listens(NEW.account_id, 'conversation.opened') THEN RETURN NULL; END IF;
  SELECT nullif(regexp_replace(coalesce(ct.phone, ''), '\D', '', 'g'), '') INTO v_phone FROM wacrm.contacts ct WHERE ct.id = NEW.contact_id;
  PERFORM wacrm.enqueue_webhook_event(NEW.account_id, 'conversation.opened', md5('conversation.opened:' || NEW.id::text)::uuid, jsonb_build_object(
    'conversation_id', NEW.id,
    'contact_id', NEW.contact_id,
    'phone', v_phone,
    'channel', coalesce(v_row ->> 'channel_type', 'whatsapp'),
    'status', NEW.status,
    'team_id', v_row ->> 'team_id',
    'assignee_id', v_row ->> 'assigned_agent_id',
    'config_id', v_row ->> 'config_id',
    'opened_at', to_char(coalesce(NEW.created_at, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'webhook_on_conversation_opened falhou: %', SQLERRM;  -- nunca derruba a abertura da conversa
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.webhook_on_conversation_assigned()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_contact uuid;
  v_actor jsonb := NULL;
  v_user uuid := NEW.actor_id;
BEGIN
  IF NEW.account_id IS NULL OR NOT wacrm.webhook_endpoint_listens(NEW.account_id, 'conversation.assigned') THEN RETURN NULL; END IF;
  SELECT c.contact_id INTO v_contact FROM wacrm.conversations c WHERE c.id = NEW.conversation_id;
  -- Ator: a linha (UPDATE feito pelo navegador) ou, se vazia, quem agiu na requisição (servidor: API, fluxo, IA, sistema).
  BEGIN
    v_actor := wacrm.audit_actor();
  EXCEPTION WHEN others THEN
    v_actor := NULL;
  END;
  PERFORM wacrm.enqueue_webhook_event(NEW.account_id, 'conversation.assigned', md5('conversation.assigned:' || NEW.id::text)::uuid, jsonb_build_object(
    'conversation_id', NEW.conversation_id,
    'contact_id', v_contact,
    'from_agent_id', NEW.from_agent_id,
    'to_agent_id', NEW.to_agent_id,
    'from_team_id', NEW.from_team_id,
    'to_team_id', NEW.to_team_id,
    'actor', jsonb_build_object(
      'type', coalesce(v_actor ->> 'actor_type', CASE WHEN v_user IS NULL THEN 'system' ELSE 'user' END),
      'user_id', coalesce(v_user::text, v_actor ->> 'user_id'),
      'source', v_actor ->> 'source'),
    'at', to_char(coalesce(NEW.created_at, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'webhook_on_conversation_assigned falhou: %', SQLERRM;  -- nunca derruba a atribuição
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.webhook_on_conversation_opened(), wacrm.webhook_on_conversation_assigned() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_webhook_conversation_opened ON wacrm.conversations;
CREATE TRIGGER trg_webhook_conversation_opened AFTER INSERT ON wacrm.conversations
  FOR EACH ROW EXECUTE FUNCTION wacrm.webhook_on_conversation_opened();
DROP TRIGGER IF EXISTS trg_webhook_conversation_assigned ON wacrm.conversation_assignments;
CREATE TRIGGER trg_webhook_conversation_assigned AFTER INSERT ON wacrm.conversation_assignments
  FOR EACH ROW EXECUTE FUNCTION wacrm.webhook_on_conversation_assigned();

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('373_webhook_conversation_events') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
