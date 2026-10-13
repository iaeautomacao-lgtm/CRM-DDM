-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (CONCURRENTLY não roda em transação).
-- 330b — índice da extração por ATUALIZAÇÃO (GET /api/v1/conversations?updated_from=…): keyset por (account_id, updated_at, id).
-- CUSTO: conversations é tabela quente — updated_at muda a cada mensagem, então este índice recebe uma entrada nova por atualização
-- (como os outros índices por data da tabela). Valide o tamanho/IO antes numa base muito grande. Sem ele a rota funciona, mais lenta
-- em contas com centenas de milhares de conversas.
-- PRÉ-CHECK: SELECT indexname FROM pg_indexes WHERE schemaname='wacrm' AND indexname='idx_conversations_account_updated';   -- 0 linhas
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_conversations_account_updated'::regclass;        -- true
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_conversations_account_updated;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_account_updated
  ON wacrm.conversations (account_id, updated_at, id);
