-- ============================================================
-- 059_flow_called_by_flow_trigger.sql — 'called_by_flow' trigger type.
--
-- Lets a flow be authored with no auto-start trigger of its own,
-- reachable only via another flow's go_to_flow node. Behaves exactly
-- like 'manual' in the engine's inbound-dispatch switch (neither
-- matches a keyword nor the first-inbound check), but is labeled
-- distinctly in the builder so it's clear the flow is meant to be a
-- callee, not dead code.
--
-- Idempotent — safe to run multiple times. Not applied to the DB by
-- this session; file only.
-- ============================================================

SET search_path TO wacrm, public, extensions;

ALTER TABLE wacrm.flows
  DROP CONSTRAINT IF EXISTS flows_trigger_type_check;

ALTER TABLE wacrm.flows
  ADD CONSTRAINT flows_trigger_type_check
  CHECK (trigger_type IN (
    'keyword',
    'first_inbound_message',
    'manual',
    'called_by_flow'
  ));
