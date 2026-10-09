-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (CONCURRENTLY não roda em transação).
-- 303b — índice de apoio das NÃO LIDAS do chat interno (internal_chat_threads e o contador do sino da sidebar contam
-- recipient_id = eu AND read_at IS NULL). Parcial: só as não lidas, então é minúsculo e nunca cresce com o histórico.
-- CUSTO: desprezível (só mensagens ainda não lidas). O app funciona sem ele.
-- PRÉ-CHECK: SELECT indexname FROM pg_indexes WHERE schemaname='wacrm' AND indexname='idx_internal_messages_unread';   -- 0 linhas
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_internal_messages_unread'::regclass;        -- true
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_internal_messages_unread;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_internal_messages_unread
  ON wacrm.internal_messages (recipient_id, sender_id)
  WHERE read_at IS NULL;
