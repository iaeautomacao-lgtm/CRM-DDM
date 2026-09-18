-- Migration 082: tabela de logs centralizados do CRM-DDM.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

CREATE TABLE IF NOT EXISTS wacrm.system_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  -- account_id nullable: logs de sistema sem conta específica (ex: webhook rejeitado antes de resolver account)
  level       text NOT NULL CHECK (level IN ('debug','info','warn','error','critical')),
  source      text NOT NULL CHECK (source IN (
    'disparador', 'webhook_meta', 'webhook_waha',
    'flows', 'ai_agent', 'automations', 'import', 'system'
  )),
  event       text NOT NULL,    -- ex: 'campaign_started', 'message_failed', 'ai_agent_error'
  message     text NOT NULL,
  payload     jsonb,            -- dados de contexto (campaign_id, contact_id, erro, etc.)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_system_logs_account_created
  ON wacrm.system_logs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_level
  ON wacrm.system_logs (level, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_source
  ON wacrm.system_logs (source, created_at DESC);

-- Retenção automática: purgar logs com mais de 30 dias
-- (executar via cron externo ou manualmente)
-- DELETE FROM wacrm.system_logs WHERE created_at < now() - interval '30 days';
