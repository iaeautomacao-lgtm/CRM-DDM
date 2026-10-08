-- ============================================================
-- 187b_disp_queue_erro_codigo_index.sql
--
-- Índice parcial para filtrar/contar erros por código dentro de uma campanha (telas de erros):
--   (campaign_id, erro_codigo, updated_at DESC) WHERE status = 'erro'
-- Só itens em erro entram — fica pequeno mesmo com milhões de linhas na fila.
--
-- RODAR SOZINHA, DEPOIS da 187: CREATE INDEX CONCURRENTLY não pode estar dentro de transação (no SQL
-- Editor do Supabase, execute este arquivo como UMA instrução, sem BEGIN/COMMIT).
-- Depois de criar, confirme que está válido:
--   SELECT indexrelid::regclass, indisvalid FROM pg_index
--   WHERE indrelid = 'wacrm.disp_message_queue'::regclass AND indexrelid::regclass::text LIKE '%erro_codigo%';
-- Se indisvalid = false: DROP INDEX CONCURRENTLY wacrm.idx_dmq_erro_codigo; e rode de novo.
--
-- Idempotente (IF NOT EXISTS).
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmq_erro_codigo
  ON wacrm.disp_message_queue (campaign_id, erro_codigo, updated_at DESC)
  WHERE status = 'erro';
