-- Migration 088: idempotência de mensagens inbound + increment atômico
-- de unread_count no webhook do WhatsApp (Meta/WAHA).
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

-- messages.message_id (migration 001) tinha só um índice não-único
-- (idx_messages_message_id) — nada impedia duas linhas com o mesmo
-- message_id. Sem isso, um redelivery de webhook (Meta retry, ou duas
-- entregas quase simultâneas do WAHA) insere a mesma mensagem duas
-- vezes. O índice é parcial (WHERE message_id IS NOT NULL) porque
-- mensagens sem message_id (ex: alguns fluxos internos) continuam
-- permitidas em qualquer quantidade — só duplicata de um message_id
-- real é que vira erro 23505, tratado no webhook como "já processado".
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id_unique
  ON wacrm.messages (message_id)
  WHERE message_id IS NOT NULL;

-- conversations.unread_count era lido em JS e regravado como valor
-- calculado (`(conversation.unread_count || 0) + 1`) — não-atômico:
-- duas mensagens do mesmo contato chegando em rajada podiam ler o
-- mesmo valor base e uma escrita perder o incremento da outra
-- (lost update). SECURITY DEFINER + search_path fixo porque o webhook
-- chama via supabaseAdmin() (service role), mesmo padrão de outras
-- RPCs do schema (ex: is_account_member).
CREATE OR REPLACE FUNCTION wacrm.increment_unread_count(conversation_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'wacrm', 'public'
AS $$
  UPDATE wacrm.conversations
  SET unread_count = unread_count + 1
  WHERE id = conversation_id;
$$;

GRANT EXECUTE ON FUNCTION wacrm.increment_unread_count(uuid) TO authenticated, service_role;
