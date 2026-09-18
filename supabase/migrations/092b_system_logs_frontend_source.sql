-- Migration 092b: adiciona 'frontend' à CHECK constraint de system_logs.source.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

-- migration 082 criou a CHECK sem cobrir eventos de frontend (ação/erro
-- capturados por /api/telemetry, ver migration 092) — o insert falharia
-- com violação de constraint antes desta migration.
ALTER TABLE wacrm.system_logs
  DROP CONSTRAINT IF EXISTS system_logs_source_check;

ALTER TABLE wacrm.system_logs
  ADD CONSTRAINT system_logs_source_check
  CHECK (source IN (
    'disparador', 'webhook_meta', 'webhook_waha',
    'flows', 'ai_agent', 'automations', 'import',
    'system', 'frontend'
  ));
