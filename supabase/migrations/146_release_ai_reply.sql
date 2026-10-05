-- Migration 146: liberar a reserva de resposta da IA (retry seguro).
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.
-- Conferir o schema live antes (CLAUDE.md).
--
-- claim_ai_reply (122) reserva (conta, conversa, mensagem, nó) para que só
-- uma execução responda cada mensagem do cliente. Se a tentativa falhava
-- depois da reserva, a mensagem nunca mais era respondida. O responder
-- (src/lib/ai/responder.ts) agora libera a reserva — e tenta UMA vez de
-- novo — quando a falha aconteceu ANTES de qualquer efeito externo
-- (nenhuma tool chamada, nada enviado ao cliente). Com efeito externo a
-- reserva permanece (evita mensagem duplicada / acordo formalizado 2x).

BEGIN;

CREATE OR REPLACE FUNCTION wacrm.release_ai_reply(
  p_account uuid,
  p_conversation uuid,
  p_message uuid,
  p_node text DEFAULT ''
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  deleted integer;
BEGIN
  DELETE FROM wacrm.ai_reply_intents
  WHERE account_id = p_account
    AND conversation_id = p_conversation
    AND inbound_message_id = p_message
    AND node_key = COALESCE(p_node, '');
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted = 1;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.release_ai_reply(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.release_ai_reply(uuid, uuid, uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
