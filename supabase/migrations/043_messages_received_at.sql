-- ============================================================
-- 043_messages_received_at
--
-- The AI agent's debounce (src/lib/ai/responder.ts) waits 4s, then
-- checks whether a newer customer message has arrived by comparing
-- Date.now() against the latest message's created_at. That column is
-- set from the WAHA/Meta webhook payload's own `timestamp` field
-- (see waha/route.ts, whatsapp/webhook/route.ts) — i.e. the
-- provider's clock, not ours. Any delivery/queueing lag between the
-- provider stamping that timestamp and our webhook actually inserting
-- the row breaks the debounce's elapsed-time math, letting two rapid
-- customer messages each get their own AI reply.
--
-- received_at fixes this by being a purely server-local timestamp:
-- DEFAULT NOW() means Postgres stamps it at INSERT time (which
-- coincides with when our webhook processed the message), with no
-- app-code changes needed in the webhook insert paths. created_at is
-- untouched — message ordering in the UI still reflects the
-- provider's timestamp, only the debounce's "how long ago did the
-- latest message actually arrive here" check moves to received_at.
--
-- Backfill sets received_at = created_at for existing rows (best
-- available approximation for history) rather than leaving them all
-- stamped with this migration's run time.
-- ============================================================

ALTER TABLE wacrm.messages
  ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;

UPDATE wacrm.messages
  SET received_at = created_at
  WHERE received_at IS NULL;

ALTER TABLE wacrm.messages
  ALTER COLUMN received_at SET DEFAULT NOW(),
  ALTER COLUMN received_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_received_at ON wacrm.messages(received_at);
