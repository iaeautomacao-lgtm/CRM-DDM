-- ============================================================
-- 374_webhook_campaign_reply.sql   (API pública Onda 2 — webhook "o cliente respondeu à campanha")
--
-- O QUE FAZ: o evento de saída assinado `campaign.reply`, só para quem assinou, a CADA resposta do cliente atribuída a um disparo (a atribuição já existe:
-- migration 126, reply-tracker.ts grava messages.campaign_id/queue_item_id/attribution_method na mensagem do cliente — por contexto/citação ('context') ou
-- pelo disparo mais recente do contato nos últimos 7 dias ('recent')). Trigger em wacrm.messages:
--   AFTER UPDATE OF campaign_id  (a atribuição chega por UPDATE depois da mensagem nascer)  E  AFTER INSERT já com campaign_id — só mensagem de cliente.
--   data: campaign_id, external_id (o da criação pela API; null nas do painel), recipient_id (item da fila), contact_id, phone, conversation_id, message_id,
--   provider_message_id, content_type, text, attribution ('context'|'recent'), at. `event_id` por mensagem: reemitir é seguro.
--   À prova de falha (EXCEPTION → WARNING; nunca derruba a gravação da resposta). Sem assinatura, custo desprezível (1 consulta por linha atribuída).
-- DADO PESSOAL: telefone e TEXTO da resposta do cliente (como em message.received): o endpoint é dado sensível (HTTPS, assinatura, sem log do corpo).
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.messages'), to_regclass('wacrm.conversations'), to_regclass('wacrm.campaigns'), to_regclass('wacrm.contacts');   -- não nulos
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='messages'
--      AND column_name IN ('campaign_id','queue_item_id','attribution_method');                                                              -- 3 linhas (126)
--   SELECT to_regprocedure('wacrm.enqueue_webhook_event(uuid, text, uuid, jsonb)'), to_regprocedure('wacrm.webhook_endpoint_listens(uuid, text)');  -- existem (204)
--   SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_webhook_campaign_reply_upd', 'trg_webhook_campaign_reply_ins') AND NOT tgisinternal;   -- 0 linhas na 1ª vez
-- VERIFICAÇÃO (depois): as mesmas 2 linhas de pg_trigger.
-- ORDEM: depois da 204 e da 126; antes ou depois do deploy (sem ela só falta o evento). Idempotente.
-- ROLLBACK:
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_webhook_campaign_reply_upd ON wacrm.messages;
--   DROP TRIGGER IF EXISTS trg_webhook_campaign_reply_ins ON wacrm.messages;
--   DROP FUNCTION IF EXISTS wacrm.webhook_on_campaign_reply();
--   DELETE FROM wacrm.schema_migrations WHERE version = '374_webhook_campaign_reply';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.messages') IS NULL OR to_regclass('wacrm.conversations') IS NULL OR to_regclass('wacrm.campaigns') IS NULL OR to_regclass('wacrm.contacts') IS NULL THEN
    RAISE EXCEPTION '374: faltam wacrm.messages / conversations / campaigns / contacts — confira o schema vivo';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'messages'
        AND column_name IN ('campaign_id', 'queue_item_id', 'attribution_method')) <> 3 THEN
    RAISE EXCEPTION '374: wacrm.messages precisa de campaign_id, queue_item_id e attribution_method (migration 126)';
  END IF;
  IF to_regprocedure('wacrm.enqueue_webhook_event(uuid, text, uuid, jsonb)') IS NULL
     OR to_regprocedure('wacrm.webhook_endpoint_listens(uuid, text)') IS NULL THEN
    RAISE EXCEPTION '374: faltam as funções de webhook da migration 204 — nada foi alterado';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.webhook_on_campaign_reply()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_account uuid;
  v_contact uuid;
  v_phone text;
  v_external text;
BEGIN
  SELECT c.account_id, c.contact_id INTO v_account, v_contact FROM wacrm.conversations c WHERE c.id = NEW.conversation_id;
  IF v_account IS NULL OR NOT wacrm.webhook_endpoint_listens(v_account, 'campaign.reply') THEN RETURN NULL; END IF;
  SELECT nullif(regexp_replace(coalesce(ct.phone, ''), '\D', '', 'g'), '') INTO v_phone FROM wacrm.contacts ct WHERE ct.id = v_contact;
  SELECT cp.idempotency_key INTO v_external FROM wacrm.campaigns cp WHERE cp.id = NEW.campaign_id AND cp.account_id = v_account;
  PERFORM wacrm.enqueue_webhook_event(v_account, 'campaign.reply', md5('campaign.reply:' || NEW.id::text)::uuid, jsonb_build_object(
    'campaign_id', NEW.campaign_id,
    'external_id', v_external,
    'recipient_id', NEW.queue_item_id,
    'contact_id', v_contact,
    'phone', v_phone,
    'conversation_id', NEW.conversation_id,
    'message_id', NEW.id,
    'provider_message_id', NEW.message_id,
    'content_type', NEW.content_type,
    'text', NEW.content_text,
    'attribution', NEW.attribution_method,
    'at', to_char(coalesce(NEW.created_at, now()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'webhook_on_campaign_reply falhou: %', SQLERRM;  -- nunca derruba a gravação da resposta
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.webhook_on_campaign_reply() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_webhook_campaign_reply_upd ON wacrm.messages;
CREATE TRIGGER trg_webhook_campaign_reply_upd AFTER UPDATE OF campaign_id ON wacrm.messages
  FOR EACH ROW WHEN (OLD.campaign_id IS NULL AND NEW.campaign_id IS NOT NULL AND NEW.sender_type = 'customer')
  EXECUTE FUNCTION wacrm.webhook_on_campaign_reply();
DROP TRIGGER IF EXISTS trg_webhook_campaign_reply_ins ON wacrm.messages;
CREATE TRIGGER trg_webhook_campaign_reply_ins AFTER INSERT ON wacrm.messages
  FOR EACH ROW WHEN (NEW.campaign_id IS NOT NULL AND NEW.sender_type = 'customer')
  EXECUTE FUNCTION wacrm.webhook_on_campaign_reply();

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('374_webhook_campaign_reply') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
