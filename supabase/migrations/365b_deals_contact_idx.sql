-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (CONCURRENTLY não roda em transação).
-- 365b — índice de negócios por contato (desempenho). A consulta "negócios deste contato" (status e etapa por contact_id, 12 mil chamadas, 46 ms cada no
-- pg_stat_statements da V2) não tinha índice: só existem deals(pipeline_id), (stage_id), (assigned_to) e (account_id), então cada chamada varria a tabela.
-- INCLUDE (status, stage_id) deixa a consulta ser respondida só pelo índice. Custo: +1 entrada por negócio (tabela pequena, escrita rara).
--
-- PRÉ-CHECK: SELECT indexname FROM pg_indexes WHERE schemaname = 'wacrm' AND tablename = 'deals' AND indexdef ILIKE '%(contact_id%';   -- 0 linhas
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_deals_contact'::regclass;                                  -- true
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_deals_contact;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deals_contact ON wacrm.deals (contact_id) INCLUDE (status, stage_id);
