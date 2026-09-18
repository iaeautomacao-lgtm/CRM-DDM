-- Migration 083: índice de performance na fila do Disparador.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.
-- Cobre a query mais quente do sistema (cron + claim_queue_item):
-- filtra por campaign_id, status e scheduled_at a cada tick do cron.
CREATE INDEX IF NOT EXISTS idx_dmq_campaign_status_scheduled
  ON wacrm.disp_message_queue (campaign_id, status, scheduled_at);
