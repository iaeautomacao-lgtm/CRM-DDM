-- Fix campaign-message reconstruction timestamps and establish the
-- production schema contract checked by the deploy pipeline.
--
-- Historical campaign sends are inserted into wacrm.messages only when a
-- customer later replies. Before this migration, received_at used DEFAULT
-- now(), which moved an old campaign template into the middle of the live
-- conversation and could make the flow engine mistake it for a fresh AI
-- response.
--
-- The UPDATE is intentionally narrow and idempotent:
--   * only bot messages tied to a campaign queue item;
--   * created_at must already match the queue item's original sent_at;
--   * received_at must be displaced by more than 5 minutes.
-- This currently repairs three confirmed rows without touching genuine
-- real-time bot messages.

BEGIN;

UPDATE wacrm.messages AS m
SET received_at = q.sent_at
FROM wacrm.disp_message_queue AS q
WHERE q.id = m.queue_item_id
  AND m.sender_type = 'bot'
  AND m.campaign_id IS NOT NULL
  AND m.queue_item_id IS NOT NULL
  AND q.sent_at IS NOT NULL
  AND abs(extract(epoch FROM (m.created_at - q.sent_at))) < 2
  AND m.received_at - m.created_at > interval '5 minutes';

-- A minimal, service-role-only contract used by .cpanel.yml before build.
-- Future schema-dependent deploys should bump this value in their migration
-- and in scripts/check-schema-readiness.mjs. If code reaches production
-- before its migration, deployment stops before Next.js is built/restarted.
CREATE OR REPLACE FUNCTION wacrm.app_schema_version()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT 143;
$$;

REVOKE ALL ON FUNCTION wacrm.app_schema_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.app_schema_version() TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
