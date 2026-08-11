-- ============================================================
-- 057_flow_runs_config_id.sql — WAHA support for the Flows engine.
--
-- Records which wacrm.whatsapp_config channel a flow_run started on,
-- so the engine can pick the right sender (Meta vs WAHA) and, for
-- WAHA specifically, the right whatsapp_config row (an account can
-- have several WAHA lines — migration 039). NULL for runs started
-- before this migration and for any run whose channel is later
-- deleted (ON DELETE SET NULL) — the run keeps going, falling back to
-- 'meta' provider resolution the same way it already does today.
--
-- Idempotent — safe to run multiple times. Not applied to the DB by
-- this session; file only.
-- ============================================================

SET search_path TO wacrm, public, extensions;

ALTER TABLE wacrm.flow_runs
  ADD COLUMN IF NOT EXISTS config_id UUID
    REFERENCES wacrm.whatsapp_config(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS flow_runs_config_id
  ON wacrm.flow_runs(config_id)
  WHERE config_id IS NOT NULL;
