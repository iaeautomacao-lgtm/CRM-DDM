
BEGIN;
ALTER TABLE wacrm.ai_decisions
  ADD COLUMN IF NOT EXISTS ai_node text,
  ADD COLUMN IF NOT EXISTS tool_error text;

CREATE INDEX IF NOT EXISTS idx_ai_decisions_ai_node
  ON wacrm.ai_decisions(account_id, ai_node, created_at DESC)
  WHERE ai_node IS NOT NULL;

NOTIFY pgrst, 'reload schema';
COMMIT;
