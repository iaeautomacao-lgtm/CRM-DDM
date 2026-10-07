-- ============================================================
-- 191b_disp_queue_erro_updated_index.sql
--
-- Índice parcial da lista/resumo da tela de Erros SEM filtro de campanha: ordem (updated_at DESC, id DESC)
-- só dos itens em erro — a paginação keyset (updated_at, id) e o resumo (191) leem as primeiras entradas
-- do índice em vez de ordenar todos os erros da conta. Com filtro de campanha, a 187b já atende.
--
-- RODAR SOZINHA, DEPOIS da 191: CREATE INDEX CONCURRENTLY não pode estar dentro de transação
-- (no SQL Editor do Supabase, execute este arquivo como UMA instrução, sem BEGIN/COMMIT).
-- Confirme: SELECT indexrelid::regclass, indisvalid FROM pg_index
--           WHERE indrelid = 'wacrm.disp_message_queue'::regclass AND indexrelid::regclass::text LIKE '%erro_updated%';
-- Se indisvalid = false: DROP INDEX CONCURRENTLY wacrm.idx_dmq_erro_updated; e rode de novo.
-- Idempotente.
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmq_erro_updated
  ON wacrm.disp_message_queue (updated_at DESC, id DESC)
  WHERE status = 'erro';
