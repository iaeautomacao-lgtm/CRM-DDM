-- 161 — Disparador server-authoritative writes.
--
-- Browser sessions keep read access required by the UI, but all writes to
-- operational campaign tables must go through server routes/RPCs using the
-- service role. RLS remains enabled as defense in depth.
--
-- SECURITY DEFINER report helpers are authenticated-only; anon/PUBLIC must
-- not be able to invoke them through PostgREST RPC.

BEGIN;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
ON TABLE wacrm.campaigns, wacrm.disp_message_queue, wacrm.campaign_metrics
FROM anon, authenticated;

REVOKE SELECT
ON TABLE wacrm.campaigns, wacrm.disp_message_queue, wacrm.campaign_metrics
FROM anon;

GRANT SELECT
ON TABLE wacrm.campaigns, wacrm.disp_message_queue, wacrm.campaign_metrics
TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE wacrm.campaigns, wacrm.disp_message_queue, wacrm.campaign_metrics
TO service_role;

REVOKE EXECUTE ON FUNCTION wacrm.get_campaign_queue_items(uuid, uuid, text, text, integer, integer)
FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION wacrm.get_campaign_report_detail(uuid, uuid)
FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION wacrm.get_campaign_stats(uuid[])
FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION wacrm.get_campaigns_for_report(uuid)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION wacrm.get_campaign_queue_items(uuid, uuid, text, text, integer, integer)
TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION wacrm.get_campaign_report_detail(uuid, uuid)
TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION wacrm.get_campaign_stats(uuid[])
TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION wacrm.get_campaigns_for_report(uuid)
TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
