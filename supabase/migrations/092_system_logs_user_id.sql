-- Migration 092: user_id/page/action em wacrm.system_logs.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

-- Expande system_logs (migration 082) para suportar logs atribuíveis a
-- um usuário (ações de negócio, erros de frontend) — hoje a tabela só
-- registra eventos de sistema (webhook, disparador, flows) sem
-- nenhuma noção de "quem". page/action ficam nullable e são só
-- preenchidos pelos novos tipos de evento (action/error) via
-- /api/telemetry — os logs de sistema existentes continuam gravando
-- do jeito que já gravam, sem esses campos.
ALTER TABLE wacrm.system_logs
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE wacrm.system_logs
  ADD COLUMN IF NOT EXISTS page text;
  -- ex: '/disparador/campanhas', '/inbox'

ALTER TABLE wacrm.system_logs
  ADD COLUMN IF NOT EXISTS action text;
  -- ex: 'campaign_created', 'csv_imported'

CREATE INDEX IF NOT EXISTS idx_system_logs_user
  ON wacrm.system_logs (user_id, created_at DESC);
