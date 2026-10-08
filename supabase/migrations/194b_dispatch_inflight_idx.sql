-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (CONCURRENTLY não roda em transação).
-- 194b — índice parcial de apoio do watchdog de itens em voo (migration 194, F14).
-- Cobre exatamente o predicado do watchdog: itens 'enviando' por data de atualização/lease (poucos em qualquer momento).
-- PRÉ-CHECK: SELECT indexname FROM pg_indexes WHERE schemaname='wacrm' AND indexname='idx_dmq_enviando_inflight';   -- 0 linhas
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_dmq_enviando_inflight'::regclass;       -- true
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_dmq_enviando_inflight;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmq_enviando_inflight
  ON wacrm.disp_message_queue (updated_at, inflight_until)
  WHERE status = 'enviando';
