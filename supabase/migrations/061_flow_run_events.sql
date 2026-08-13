-- ============================================================
-- 061_flow_run_events.sql — richer per-node run logging.
--
-- The spec for this migration asked for a fresh `wacrm.flow_run_events`
-- table (run_id, flow_id, account_id, node_key, node_type, event_type,
-- status, payload, error_message, duration_ms). That table already
-- exists — migration 010 created it (as `flow_run_events`, later moved
-- into the `wacrm` schema alongside every other table) and the engine
-- (src/lib/flows/engine.ts) has been writing to it in production ever
-- since (idempotency check `isDuplicateInbound` scans it for
-- `reply_received` rows). A `CREATE TABLE IF NOT EXISTS` with the
-- spec's column list would silently no-op against the existing table
-- and never add the new columns.
--
-- So this migration ALTERs the existing table in place instead:
--   - Adds flow_id / account_id (denormalized off flow_runs so the
--     run-history API and future account/flow-wide queries don't have
--     to join through flow_runs just to filter).
--   - Adds node_type, status, error_message, duration_ms for the
--     richer per-node timeline the /flows/[id]/runs page renders.
--   - Widens the event_type CHECK to add the new lifecycle event
--     names ('run_started', 'node_completed', 'node_error',
--     'run_completed', 'run_error') used by the new `logRunEvent`
--     helper, while keeping every value already in use by the
--     existing `logEvent` helper (started/node_entered/message_sent/
--     reply_received/fallback_fired/handoff/timeout/error/completed)
--     so historical rows and existing call sites stay valid.
--
-- The existing column is `flow_run_id`, not `run_id` — kept as-is
-- rather than renamed, since renaming a column a live engine writes
-- to every dispatch is a much riskier change than adding columns, and
-- every reader (API route, engine) can keep using the existing name.
--
-- Idempotent — safe to run multiple times. File only, NOT applied to
-- the database by this session.
-- ============================================================

SET search_path TO wacrm, public, extensions;

ALTER TABLE wacrm.flow_run_events
  ADD COLUMN IF NOT EXISTS flow_id UUID REFERENCES wacrm.flows(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS account_id UUID,
  ADD COLUMN IF NOT EXISTS node_type TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT CHECK (status IN ('success', 'error', 'skipped')),
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

-- Backfill flow_id / account_id for any rows written before this
-- migration, so older runs show up correctly in flow_id/account_id
-- scoped queries too.
UPDATE wacrm.flow_run_events e
SET flow_id = r.flow_id,
    account_id = r.account_id
FROM wacrm.flow_runs r
WHERE e.flow_run_id = r.id
  AND (e.flow_id IS NULL OR e.account_id IS NULL);

ALTER TABLE wacrm.flow_run_events
  DROP CONSTRAINT IF EXISTS flow_run_events_event_type_check;

ALTER TABLE wacrm.flow_run_events
  ADD CONSTRAINT flow_run_events_event_type_check
  CHECK (event_type IN (
    -- Pre-existing values (src/lib/flows/engine.ts's logEvent).
    'started',
    'node_entered',
    'message_sent',
    'reply_received',
    'fallback_fired',
    'handoff',
    'timeout',
    'error',
    'completed',
    -- New values (logRunEvent) for the run-history timeline.
    'run_started',
    'node_completed',
    'node_error',
    'run_completed',
    'run_error'
  ));

CREATE INDEX IF NOT EXISTS flow_run_events_run_id
  ON wacrm.flow_run_events(flow_run_id);

CREATE INDEX IF NOT EXISTS flow_run_events_flow_id
  ON wacrm.flow_run_events(flow_id)
  WHERE flow_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS flow_run_events_account_id
  ON wacrm.flow_run_events(account_id)
  WHERE account_id IS NOT NULL;

-- RLS: unchanged. Migration 010 already scopes SELECT to the owning
-- flow_run's user (service_role, used by the engine's admin client,
-- bypasses RLS for all writes) — the same read-only-for-owner /
-- write-only-via-service_role split the spec asked for. No new
-- columns here need a different policy.
