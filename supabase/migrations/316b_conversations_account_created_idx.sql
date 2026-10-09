-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (sem outro comando junto).
-- 316b — conversas por organização e data de criação (auditoria de backend B-14).
-- Relatórios e monitoramento filtram por período: monitoramento/dia, /sla e /conversations (metric=received),
-- src/lib/api/v1/reporting.ts (API v1 /reports) e src/lib/intelligence/data.ts. O único índice com created_at hoje é
-- (account_id, contact_id, channel_type, created_at), que não serve a filtro só por conta + período: a consulta varre a conta.
-- CUSTO: +1 entrada por conversa. CONCURRENTLY não bloqueia escrita; rode fora do pico.
-- PRÉ-CHECK: SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='wacrm' AND tablename='conversations'
--             AND indexdef ILIKE '%(account_id, created_at%';                                                       -- 0 linhas (senão, já existe outro igual)
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_conversations_account_created'::regclass;   -- true
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_conversations_account_created;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_account_created
  ON wacrm.conversations (account_id, created_at DESC);
