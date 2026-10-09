-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (CONCURRENTLY não roda em transação).
-- 302b — índice de apoio do "Meus atendidos" (wacrm.inbox_my_handled, migration 302): conversation_assignments por conta + quem atendeu
-- (from_agent_id) + data. Só existia idx_conversation_assignments_agent (account_id, to_agent_id, created_at). Parcial: só linhas com atendente de origem.
-- CUSTO: +1 índice numa tabela de escrita moderada (1 linha por troca de atendente/equipe). A função funciona sem ele, só mais devagar.
--
-- PRÉ-CHECK: SELECT indexname FROM pg_indexes WHERE schemaname='wacrm' AND indexname='idx_conversation_assignments_from_agent';   -- 0 linhas
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_conversation_assignments_from_agent'::regclass;        -- true
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_conversation_assignments_from_agent;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversation_assignments_from_agent
  ON wacrm.conversation_assignments (account_id, from_agent_id, created_at DESC)
  WHERE from_agent_id IS NOT NULL;
