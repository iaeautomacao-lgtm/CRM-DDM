-- ============================================================
-- 067_flow_run_events_tool_event_types.sql — allow ai_agent tool-call
-- events in flow_run_events.
--
-- The ai_agent node's OpenAI function-calling loop (src/lib/ai/
-- responder.ts's generateOpenAiResponse) now reports two events per
-- tool call via logRunEvent (src/lib/flows/engine.ts):
--   - 'tool_called' — logged right before the HTTP request the tool
--     definition describes is fired.
--   - 'tool_result' — logged right after that HTTP request resolves
--     (or fails), with the (truncated) response body and duration_ms.
--
-- flow_run_events_event_type_check (added by migration 061) doesn't
-- include either value, so every insert attempting to log them fails
-- the CHECK constraint — logRunEvent swallows the error (console.error
-- only, doesn't throw), so today these events are silently dropped.
-- This migration widens the constraint the same way 061 widened the
-- one before it: drop and recreate with the full existing list plus
-- the two new values.
--
-- Idempotent — safe to run multiple times. File only, NOT applied to
-- the database by this session.
-- ============================================================

SET search_path TO wacrm, public, extensions;

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
    -- Values added by migration 061 (logRunEvent) for the run-history
    -- timeline.
    'run_started',
    'node_completed',
    'node_error',
    'run_completed',
    'run_error',
    -- New values (logRunEvent) for the ai_agent tool-calling loop.
    'tool_called',
    'tool_result'
  ));
