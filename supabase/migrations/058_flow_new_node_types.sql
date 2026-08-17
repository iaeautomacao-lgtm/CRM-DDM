-- ============================================================
-- 058_flow_new_node_types.sql — 8 new Flow node types.
--
-- Adds http_fetch (already allowed by the CHECK since migration 010,
-- but never implemented by the engine until now), set_variable,
-- smart_delay, anchor, go_to, go_to_flow, send_template, add_note,
-- receive_attachment.
--
-- flow_runs.status: preserves ALL 6 existing values (handed_off and
-- failed are written throughout engine.ts today — dropping them would
-- break every handoff/error path) and adds 3 new terminal/suspend
-- states the new node types need:
--   - 'error'       — go_to's MAX_HOPS (50) safety cap
--   - 'transferred' — go_to_flow handing off to another flow
--   - 'delayed'     — smart_delay suspending until wake_at
--
-- wake_at + the partial index let the cron (route.ts) cheaply find
-- runs due to wake up without scanning every active run.
--
-- Idempotent — safe to run multiple times. Not applied to the DB by
-- this session; file only.
-- ============================================================

SET search_path TO wacrm, public, extensions;

-- ------------------------------------------------------------
-- 1. flow_nodes.node_type — add the 8 new values, preserving the 11
--    that exist today (010_flows.sql's original 10 + send_media from
--    016_flow_media.sql).
-- ------------------------------------------------------------
ALTER TABLE wacrm.flow_nodes
  DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;

ALTER TABLE wacrm.flow_nodes
  ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'collect_input',
    'condition',
    'set_tag',
    'handoff',
    'http_fetch',
    'end',
    'send_media',
    'set_variable',
    'smart_delay',
    'anchor',
    'go_to',
    'go_to_flow',
    'send_template',
    'add_note',
    'receive_attachment'
  ));

-- ------------------------------------------------------------
-- 2. flow_runs — wake_at + hops_count for smart_delay / go_to.
-- ------------------------------------------------------------
ALTER TABLE wacrm.flow_runs
  ADD COLUMN IF NOT EXISTS wake_at TIMESTAMPTZ;

ALTER TABLE wacrm.flow_runs
  ADD COLUMN IF NOT EXISTS hops_count INT NOT NULL DEFAULT 0;

-- ------------------------------------------------------------
-- 3. flow_runs.status — preserve the 6 existing values, add 3 new.
-- ------------------------------------------------------------
ALTER TABLE wacrm.flow_runs
  DROP CONSTRAINT IF EXISTS flow_runs_status_check;

ALTER TABLE wacrm.flow_runs
  ADD CONSTRAINT flow_runs_status_check
  CHECK (status IN (
    'active',
    'completed',
    'handed_off',
    'timed_out',
    'paused_by_agent',
    'failed',
    'error',
    'transferred',
    'delayed'
  ));

CREATE INDEX IF NOT EXISTS flow_runs_delayed_wake
  ON wacrm.flow_runs(wake_at)
  WHERE status = 'delayed' AND wake_at IS NOT NULL;
