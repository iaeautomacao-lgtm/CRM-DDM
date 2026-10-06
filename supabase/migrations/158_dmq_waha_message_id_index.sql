-- ============================================================
-- 158_dmq_waha_message_id_index.sql — índice para recibos de entrega.
--
-- ATENÇÃO — RODAR SOZINHO no Supabase SQL Editor (uma única instrução,
-- sem nada antes/depois na mesma execução):
--   CREATE INDEX CONCURRENTLY não pode rodar dentro de BEGIN/COMMIT nem
--   junto com outras instruções no mesmo lote. Por isso este arquivo NÃO
--   tem BEGIN/COMMIT nem NOTIFY. Se o editor reclamar de "cannot run inside
--   a transaction block", cole só a linha do CREATE INDEX e execute.
--
-- Por quê: todo webhook de status da Meta (sent/delivered/read/failed) chama
-- wacrm.apply_dispatch_status, que faz
--   SELECT ... FROM wacrm.disp_message_queue WHERE waha_message_id = $1 FOR UPDATE
-- (migrations 119/125/133), e reconcile_dispatch_receipts faz JOIN pela
-- mesma coluna. Sem índice, cada recibo varre a fila inteira — numa campanha
-- de milhares de itens são milhares de seq scans por minuto disputando a
-- tabela com o próprio envio. A limpeza de recibos órfãos (migration 159)
-- também usa este índice.
--
-- CONCURRENTLY: não bloqueia escrita na fila enquanto o índice é criado
-- (pode rodar com campanha em andamento). IF NOT EXISTS: produção pode já
-- ter o índice criado manualmente com este nome — aí não faz nada.
-- Se uma execução anterior foi interrompida, o índice pode ter ficado
-- INVALID; conferir com:
--   SELECT indexrelid::regclass, indisvalid FROM pg_index
--   WHERE indexrelid = 'wacrm.idx_dmq_waha_message_id'::regclass;
-- e, se indisvalid = false, rodar DROP INDEX CONCURRENTLY
-- wacrm.idx_dmq_waha_message_id; e este arquivo de novo.
--
-- Pode ser aplicado antes ou depois do deploy (o código não depende dele).
-- ============================================================

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dmq_waha_message_id
  ON wacrm.disp_message_queue (waha_message_id)
  WHERE waha_message_id IS NOT NULL;
