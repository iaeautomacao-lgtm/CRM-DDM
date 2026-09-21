-- Migration 099: adiciona 'api_v1' à CHECK constraint de system_logs.source.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

-- Necessária para logar chamadas à API pública (/api/v1/*) — sem isso o
-- insert em writeLog({ source: 'api_v1', ... }) falharia com violação de
-- constraint (mesmo padrão da migration 092b para 'frontend').
ALTER TABLE wacrm.system_logs
  DROP CONSTRAINT IF EXISTS system_logs_source_check;

ALTER TABLE wacrm.system_logs
  ADD CONSTRAINT system_logs_source_check
  CHECK (source IN (
    'disparador', 'webhook_meta', 'webhook_waha',
    'flows', 'ai_agent', 'automations', 'import',
    'system', 'frontend', 'api_v1'
  ));
