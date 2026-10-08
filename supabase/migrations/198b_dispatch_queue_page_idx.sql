-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (CONCURRENTLY não roda em transação).
-- 198b — índice de apoio da paginação do detalhamento da fila (queue-details), OPCIONAL (migration 198, A20).
-- A página ordena por (sent_at DESC NULLS LAST, scheduled_at DESC, id) dentro de UMA campanha: sem este índice o banco
-- precisa ordenar todos os itens da campanha (100 mil) a cada página; com ele lê só os N primeiros.
--
-- CUSTO: o índice é mantido a cada UPDATE de sent_at/scheduled_at (envio confirmado, reagendamento) — o caminho quente do
-- disparador. Valide na bancada (S2/S3) que a vazão por número não cai antes de ligar em produção; o app funciona sem ele.
--
-- PRÉ-CHECK: SELECT indexname FROM pg_indexes WHERE schemaname='wacrm' AND indexname='idx_dmq_campaign_page';   -- 0 linhas
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_dmq_campaign_page'::regclass;        -- true
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_dmq_campaign_page;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmq_campaign_page
  ON wacrm.disp_message_queue (campaign_id, sent_at DESC NULLS LAST, scheduled_at DESC, id);
