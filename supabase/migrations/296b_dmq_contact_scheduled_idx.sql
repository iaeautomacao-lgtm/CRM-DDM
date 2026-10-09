-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (CONCURRENTLY não roda em transação).
-- 296b — índice da aba "Campanhas" do contato (GET /api/contacts/[id]/campaigns, TASK36).
-- Hoje só existe idx_dispatch_contact_sent_at (migration 126), parcial em sent_at NOT NULL: não cobre o que ainda não saiu
-- (agendado/pausado/erro). A aba lê os envios do contato do mais novo ao mais antigo por (scheduled_at, id).
-- CUSTO: +1 entrada por item da fila em disp_message_queue (tabela de 100k+ itens por campanha); só itens com contact_id
-- (contato externo da API v1 não entra). Valide o tamanho antes numa base muito grande. O app funciona sem o índice.
-- PRÉ-CHECK: SELECT indexname FROM pg_indexes WHERE schemaname='wacrm' AND indexname='idx_dmq_contact_scheduled';   -- 0 linhas
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_dmq_contact_scheduled'::regclass;       -- true
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_dmq_contact_scheduled;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmq_contact_scheduled
  ON wacrm.disp_message_queue (contact_id, scheduled_at DESC, id DESC)
  WHERE contact_id IS NOT NULL;
