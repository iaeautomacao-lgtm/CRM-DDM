-- ⚠️ RODAR SOZINHO: só a linha CREATE INDEX, numa execução própria do SQL Editor (CONCURRENTLY não roda em transação).
-- 294b — índice do auto-pause para REJEIÇÕES (PRD 11 — F7).
-- A consulta de rejeitados do auto-pause (sent_at IS NULL, ordenada por updated_at desc, limit 100) usava
-- idx_dmq_auto_pause_attempts (migration 159), que guarda TODOS os envios da campanha: com poucas rejeições nunca
-- fechava as 100 linhas e varria o índice inteiro (100k+ entradas + heap). Este índice só contém quem NÃO foi
-- enviado (rejeitado antes de sair), então a leitura é O(rejeições).
-- O predicado NÃO inclui a regra de erro_permanente: erro transitório com código de nível campanha (Meta) também conta, e o
-- planner só usa o índice se a consulta implicar o predicado (o código passa a filtrar status IN (erro, bloqueado) nos rejeitados).
-- CUSTO: um índice parcial pequeno em disp_message_queue (só linhas rejeitadas sem sent_at).
-- PRÉ-CHECK: SELECT indexname FROM pg_indexes WHERE schemaname='wacrm' AND indexname='idx_dmq_auto_pause_rejected';   -- 0 linhas
-- DEPOIS:    SELECT indisvalid FROM pg_index WHERE indexrelid = 'wacrm.idx_dmq_auto_pause_rejected'::regclass;          -- true
--            EXPLAIN da consulta (campanha grande) deve usar idx_dmq_auto_pause_rejected.
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.idx_dmq_auto_pause_rejected;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmq_auto_pause_rejected
  ON wacrm.disp_message_queue (campaign_id, updated_at DESC)
  WHERE sent_at IS NULL
    AND tentativas > 0
    AND status IN ('erro', 'bloqueado');
