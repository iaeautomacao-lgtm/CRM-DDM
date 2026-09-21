-- Migration 101: adiciona 'feedback' à CHECK constraint de system_logs.source.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

-- Necessária para o botão de feedback flutuante (POST /api/feedback)
-- gravar em system_logs — sem isso o insert falha na constraint (mesmo
-- padrão das migrations 092b/099 para 'frontend'/'api_v1').
ALTER TABLE wacrm.system_logs
  DROP CONSTRAINT IF EXISTS system_logs_source_check;

ALTER TABLE wacrm.system_logs
  ADD CONSTRAINT system_logs_source_check
  CHECK (source IN (
    'disparador', 'webhook_meta', 'webhook_waha',
    'flows', 'ai_agent', 'automations', 'import',
    'system', 'frontend', 'api_v1', 'feedback'
  ));
