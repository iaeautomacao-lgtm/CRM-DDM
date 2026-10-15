-- ============================================================
-- 361_webhook_recipient_status.sql   (API pública Onda 1, bloco B — decisão do dono 15/10, item 5 = c)
--
-- O QUE FAZ: o evento `recipient.status` (webhook de saída assinado) para quem assinou, a cada TRANSIÇÃO FINAL de um destinatário de
-- campanha: entregue (`delivered`), lido (`read`), erro (`error`), bloqueado (`blocked`) e removido (`removed`, quando
-- `cancel_reason` começa com `removed_api:`, gravado por remove_campaign_recipients da migration 357). Não emite queued/sending/sent
-- (o ERP já sabe pelo POST e pela lista) nem o `cancelado` de um encerramento de campanha (esse tem o evento campaign.cancelled, com contagem).
--   1. wacrm.webhook_recipient_payload(wacrm.disp_message_queue)   monta o `data` comum (campanha, external_id, destinatário, telefone,
--      referência); usado também pelo recipient.funnel (migration 362). Lê cancel_reason/reference/erro_codigo por to_jsonb: funciona com
--      ou sem as colunas da 357.
--   2. wacrm.webhook_on_queue_status()  + trigger trg_webhook_queue_status (AFTER UPDATE OF status em disp_message_queue).
--      Só trabalha se a conta tem endpoint ativo assinando `recipient.status` (1 consulta indexada por linha; sem assinatura, custo
--      desprezível). À prova de falha: EXCEPTION → WARNING, NUNCA derruba o envio. `event_id` determinístico por (destinatário, status):
--      reemitir é seguro (idempotente por endpoint) e o mesmo status final sai UMA vez por destinatário.
-- DADO PESSOAL: o payload leva o telefone do destinatário (nunca CPF, nem o texto da mensagem). O endpoint é dado sensível (HTTPS, assinado).
-- VOLUME: centenas de milhares de entregas/dia são esperadas; o teto por endpoint é a coluna rate_limit_per_minute da migration 360.
-- COMPATIBILIDADE: sem esta migration só falta o evento por destinatário; os eventos de campanha não dependem dela.
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.disp_message_queue'), to_regclass('wacrm.campaigns'), to_regclass('wacrm.contacts');   -- não nulos
--   SELECT to_regprocedure('wacrm.enqueue_webhook_event(uuid, text, uuid, jsonb)'), to_regprocedure('wacrm.webhook_endpoint_listens(uuid, text)');  -- existem (204)
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='disp_message_queue'
--      AND column_name IN ('id','account_id','campaign_id','contact_id','status','mensagem_final');                -- 6 linhas
--   SELECT tgname FROM pg_trigger WHERE tgname = 'trg_webhook_queue_status' AND NOT tgisinternal;                   -- 0 linhas na 1ª vez
-- VERIFICAÇÃO (depois): SELECT tgname FROM pg_trigger WHERE tgname = 'trg_webhook_queue_status' AND NOT tgisinternal;  -- 1 linha
-- ORDEM: depois da 204; antes ou depois do deploy. Idempotente.
-- ROLLBACK:
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_webhook_queue_status ON wacrm.disp_message_queue;
--   DROP FUNCTION IF EXISTS wacrm.webhook_on_queue_status();
--   DROP FUNCTION IF EXISTS wacrm.webhook_recipient_payload(wacrm.disp_message_queue);   -- só se a 362 não estiver aplicada
--   DELETE FROM wacrm.schema_migrations WHERE version = '361_webhook_recipient_status';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.disp_message_queue') IS NULL OR to_regclass('wacrm.campaigns') IS NULL OR to_regclass('wacrm.contacts') IS NULL THEN
    RAISE EXCEPTION '361: faltam wacrm.disp_message_queue / campaigns / contacts — confira o schema vivo';
  END IF;
  IF to_regprocedure('wacrm.enqueue_webhook_event(uuid, text, uuid, jsonb)') IS NULL
     OR to_regprocedure('wacrm.webhook_endpoint_listens(uuid, text)') IS NULL THEN
    RAISE EXCEPTION '361: faltam as funções de webhook da migration 204 — nada foi alterado';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'disp_message_queue'
        AND column_name IN ('id', 'account_id', 'campaign_id', 'contact_id', 'status', 'mensagem_final')) <> 6 THEN
    RAISE EXCEPTION '361: wacrm.disp_message_queue precisa de id, account_id, campaign_id, contact_id, status e mensagem_final';
  END IF;
END $$;

-- `data` comum dos eventos por destinatário. Telefone: do contato do CRM; contato externo (campanha da API) guarda o número em mensagem_final.
CREATE OR REPLACE FUNCTION wacrm.webhook_recipient_payload(p_q wacrm.disp_message_queue)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_row jsonb := to_jsonb(p_q);
  v_external text;
  v_phone text;
BEGIN
  SELECT c.idempotency_key INTO v_external FROM wacrm.campaigns c WHERE c.id = p_q.campaign_id;
  IF p_q.contact_id IS NOT NULL THEN
    SELECT regexp_replace(coalesce(ct.phone, ''), '\D', '', 'g') INTO v_phone FROM wacrm.contacts ct WHERE ct.id = p_q.contact_id;
  ELSE
    v_phone := regexp_replace(coalesce(p_q.mensagem_final, ''), '\D', '', 'g');
  END IF;
  RETURN jsonb_build_object(
    'campaign_id', p_q.campaign_id,
    'external_id', v_external,
    'recipient_id', p_q.id,
    'phone', nullif(v_phone, ''),
    'reference', nullif(v_row ->> 'reference', ''));
END;
$$;

-- Status da fila → enum da API (mesmo mapa de GET …/recipients).
CREATE OR REPLACE FUNCTION wacrm.webhook_queue_status_name(p_status text, p_cancel_reason text DEFAULT NULL)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = wacrm, public
AS $$
  SELECT CASE p_status
    WHEN 'agendado' THEN 'queued' WHEN 'pendente' THEN 'queued' WHEN 'pausado' THEN 'paused' WHEN 'enviando' THEN 'sending'
    WHEN 'enviado' THEN 'sent' WHEN 'entregue' THEN 'delivered' WHEN 'lido' THEN 'read' WHEN 'erro' THEN 'error'
    WHEN 'bloqueado' THEN 'blocked'
    WHEN 'cancelado' THEN CASE WHEN coalesce(p_cancel_reason, '') LIKE 'removed\_api:%' THEN 'removed' ELSE 'cancelled' END
    ELSE 'queued' END
$$;

CREATE OR REPLACE FUNCTION wacrm.webhook_on_queue_status()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_row jsonb;
  v_status text;
  v_error jsonb := NULL;
  v_code integer;
  v_text text;
BEGIN
  IF NEW.account_id IS NULL OR NOT wacrm.webhook_endpoint_listens(NEW.account_id, 'recipient.status') THEN RETURN NULL; END IF;
  v_row := to_jsonb(NEW);
  v_status := wacrm.webhook_queue_status_name(NEW.status, v_row ->> 'cancel_reason');
  -- Só transições finais. `cancelled` (encerramento da campanha) tem o evento campaign.cancelled, com contagem.
  IF v_status NOT IN ('delivered', 'read', 'error', 'blocked', 'removed') THEN RETURN NULL; END IF;

  IF v_status = 'error' THEN
    v_code := CASE WHEN coalesce(v_row ->> 'erro_codigo', '') ~ '^\d{1,9}$' THEN (v_row ->> 'erro_codigo')::integer END;
    v_text := coalesce(v_row ->> 'erro', '');
    -- Mesma classificação grossa de classificarTipoErro (normalize-meta-error.ts), em códigos estáveis. Texto técnico cru NUNCA sai.
    v_error := jsonb_build_object('code', v_code, 'type', CASE
      WHEN v_code = 131008 OR v_text ~ '^Variável \{\{\d+\}\} vazia' OR v_text ~ 'sem valor mapeado' THEN 'empty_variable'
      WHEN v_code IN (131026, 131047) THEN 'window_24h'
      WHEN v_text ~* 'timeout' THEN 'timeout'
      WHEN v_text LIKE '%Canal não encontrado%' THEN 'channel_offline'
      ELSE 'other' END);
  END IF;

  PERFORM wacrm.enqueue_webhook_event(NEW.account_id, 'recipient.status',
    md5('recipient.status:' || NEW.id::text || ':' || v_status)::uuid,
    wacrm.webhook_recipient_payload(NEW) || jsonb_build_object(
      'previous_status', wacrm.webhook_queue_status_name(OLD.status, NULL),
      'status', v_status,
      'error', v_error,
      'at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'webhook_on_queue_status falhou: %', SQLERRM;  -- nunca derruba o envio
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.webhook_recipient_payload(wacrm.disp_message_queue), wacrm.webhook_queue_status_name(text, text),
  wacrm.webhook_on_queue_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.webhook_recipient_payload(wacrm.disp_message_queue), wacrm.webhook_queue_status_name(text, text) TO service_role;

DROP TRIGGER IF EXISTS trg_webhook_queue_status ON wacrm.disp_message_queue;
CREATE TRIGGER trg_webhook_queue_status AFTER UPDATE OF status ON wacrm.disp_message_queue
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('entregue', 'lido', 'erro', 'bloqueado', 'cancelado'))
  EXECUTE FUNCTION wacrm.webhook_on_queue_status();

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('361_webhook_recipient_status') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
