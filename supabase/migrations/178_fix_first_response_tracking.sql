-- 174 — Corrige rastreamento da primeira resposta humana no WhatsApp.
--
-- O envio pelo Inbox passa a persistir messages.sender_id. No WAHA, porém,
-- o eco fromMe pode chegar antes e inserir a mensagem como agent com
-- sender_id NULL. persistOutboundMessage então "adota" esse eco via UPDATE.
-- O trigger anterior escutava apenas INSERT, logo a primeira resposta podia
-- continuar sem ser registrada mesmo depois de sender_id ser preenchido.
--
-- Mantemos a exigência sender_id IS NOT NULL para não classificar ecos de
-- automações/bots como resposta humana antes da reconciliação do outbound.

BEGIN;

CREATE OR REPLACE FUNCTION wacrm.track_conversation_sla()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = wacrm, public AS $$
BEGIN
  IF NEW.sender_type = 'customer' THEN
    UPDATE wacrm.conversations SET last_customer_message_at = NEW.created_at
      WHERE id = NEW.conversation_id
        AND (last_customer_message_at IS NULL OR last_customer_message_at < NEW.created_at);
  ELSIF NEW.sender_type = 'agent' AND NEW.sender_id IS NOT NULL THEN
    UPDATE wacrm.conversations SET first_response_at = NEW.created_at
      WHERE id = NEW.conversation_id AND first_response_at IS NULL
        AND last_customer_message_at IS NOT NULL;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_track_conversation_sla ON wacrm.messages;
CREATE TRIGGER trg_track_conversation_sla
  AFTER INSERT OR UPDATE OF sender_type, sender_id ON wacrm.messages
  FOR EACH ROW EXECUTE FUNCTION wacrm.track_conversation_sla();

COMMIT;
