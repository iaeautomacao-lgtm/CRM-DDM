-- ============================================================
-- 074_whatsapp_test_sends.sql — ephemeral tracking table for the
-- "Testar canal" one-off Meta sends.
--
-- channel-test/route.ts fires a one-off template send to verify a
-- Meta channel works, deliberately WITHOUT creating a conversation/
-- messages row (see that file's docstring) — the test must not show
-- up in the customer's real conversation thread. But that means the
-- webhook's handleStatusUpdate (src/app/api/whatsapp/webhook/route.ts)
-- has nothing in `messages` to update when Meta reports delivered/
-- read/failed for that wamid, so the "Testar canal" dialog previously
-- had no way to learn whether a test send actually succeeded —
-- errors like 131042 (billing) only ever appeared async, after the
-- dialog already showed a plain success toast.
--
-- This table is the same pattern already used for broadcast_recipients
-- and disp_message_queue in handleStatusUpdate: a side table keyed by
-- Meta's message_id (wamid) that the webhook mirrors status into,
-- with NO foreign key to conversations — so it never touches the
-- inbox. Rows are single-shot and short-lived (a test dialog polls
-- for ~15s); nothing prunes old rows yet, revisit if volume becomes
-- a concern.
--
-- Status values mirror Meta's raw webhook vocabulary directly
-- (sent/delivered/read/failed) rather than being translated, since
-- the polling client compares against those literal strings.
-- ============================================================

SET search_path TO wacrm, public, extensions;

CREATE TABLE IF NOT EXISTS wacrm.whatsapp_test_sends (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  config_id   uuid REFERENCES wacrm.whatsapp_config(id) ON DELETE CASCADE,
  message_id  text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'sent',
  erro        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_test_sends_message_id_idx
  ON wacrm.whatsapp_test_sends (message_id);

ALTER TABLE wacrm.whatsapp_test_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.whatsapp_test_sends FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_test_sends_select ON wacrm.whatsapp_test_sends;
DROP POLICY IF EXISTS whatsapp_test_sends_insert ON wacrm.whatsapp_test_sends;

-- SELECT: the dialog polls this table directly via the browser
-- client (user session, RLS-bound) — members of the account can see
-- their own account's test sends.
CREATE POLICY whatsapp_test_sends_select ON wacrm.whatsapp_test_sends
  FOR SELECT USING (is_account_member(account_id));

-- INSERT: channel-test/route.ts inserts via the cookie-bound server
-- client (not a service-role client), so this needs a matching
-- policy — the route already validated the caller owns `configId`
-- before this point.
CREATE POLICY whatsapp_test_sends_insert ON wacrm.whatsapp_test_sends
  FOR INSERT WITH CHECK (is_account_member(account_id));

-- No UPDATE policy: handleStatusUpdate writes status/erro via the
-- webhook's service-role client (supabaseAdmin()), which bypasses RLS.

NOTIFY pgrst, 'reload schema';
