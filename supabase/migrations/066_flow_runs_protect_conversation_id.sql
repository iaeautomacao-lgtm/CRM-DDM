ALTER TABLE wacrm.flow_runs
  DROP CONSTRAINT IF EXISTS flow_runs_conversation_id_fkey,
  ADD CONSTRAINT flow_runs_conversation_id_fkey
    FOREIGN KEY (conversation_id)
    REFERENCES wacrm.conversations(id)
    ON DELETE RESTRICT;

COMMENT ON CONSTRAINT flow_runs_conversation_id_fkey ON wacrm.flow_runs
IS 'Prevent conversation deletion while a flow_run references it. Delete the run first.';
