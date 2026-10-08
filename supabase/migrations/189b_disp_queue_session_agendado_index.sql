-- ============================================================
-- 189b_disp_queue_session_agendado_index.sql
--
-- Índice parcial para "quantos itens ainda estão agendados neste número" no Monitor ao vivo
-- (wacrm.dispatch_monitor_counts, 189). Só itens 'agendado' entram — encolhe conforme a fila é enviada.
-- A contagem do Monitor é LIMITADA a 10.001 linhas por número, então o custo é no máximo ~10 mil
-- entradas de índice por consulta (cacheada 2–3 s no servidor).
--
-- RODAR SOZINHA, DEPOIS da 189: CREATE INDEX CONCURRENTLY não pode estar dentro de transação
-- (no SQL Editor do Supabase, execute este arquivo como UMA instrução, sem BEGIN/COMMIT).
-- Confirme: SELECT indexrelid::regclass, indisvalid FROM pg_index
--           WHERE indrelid = 'wacrm.disp_message_queue'::regclass AND indexrelid::regclass::text LIKE '%session_agendado%';
-- Se indisvalid = false: DROP INDEX CONCURRENTLY wacrm.idx_dmq_session_agendado; e rode de novo.
-- Sem este índice o Monitor NÃO varre a fila: o campo "na fila" por número vem vazio e a fila restante
-- é mostrada por campanha (campaign_metrics).
-- Idempotente.
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmq_session_agendado
  ON wacrm.disp_message_queue (session_id, scheduled_at)
  WHERE status = 'agendado';
