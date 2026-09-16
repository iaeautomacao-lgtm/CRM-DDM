-- Migration 078: suporte a disparo em lote no worker
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

-- batch_size: quantos itens processar em paralelo por campanha por tick
-- (default 1 = comportamento atual, sem quebra)
ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS batch_size integer NOT NULL DEFAULT 1;

-- batch_pause_seconds: pausa em segundos entre lotes consecutivos
-- (separada do intervalo_min/max por-contato e das pausas anti-spam)
ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS batch_pause_seconds integer NOT NULL DEFAULT 0;
