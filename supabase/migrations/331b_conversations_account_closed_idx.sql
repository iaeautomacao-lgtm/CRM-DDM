-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (CONCURRENTLY não roda em transação).
-- 331b — índice da extração por ENCERRAMENTO (GET /api/v1/conversations?closed_from=…): keyset por (account_id, closed_at, id).
-- Parcial (só conversas já encerradas): closed_at quase não muda depois de gravado, então o custo de escrita é baixo.
-- PRÉ-CHECK: SELECT indexname FROM pg_indexes WHERE schemaname='wacrm' AND indexname='idx_conversations_account_closed';   -- 0 linhas
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_conversations_account_closed'::regclass;        -- true
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_conversations_account_closed;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_account_closed
  ON wacrm.conversations (account_id, closed_at, id)
  WHERE closed_at IS NOT NULL;
