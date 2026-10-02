BEGIN;
CREATE OR REPLACE FUNCTION wacrm.renew_cron_lock(p_name text,p_owner text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE affected integer;
BEGIN
 UPDATE wacrm.cron_locks SET expires_at=clock_timestamp()+interval '600 seconds'
 WHERE name=p_name AND owner_id=p_owner AND expires_at>clock_timestamp();
 GET DIAGNOSTICS affected=ROW_COUNT;RETURN affected=1;
END; $$;
ALTER TABLE wacrm.conversations ADD COLUMN IF NOT EXISTS assignment_retry_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_assignment_retry ON wacrm.conversations(assignment_retry_at,updated_at) WHERE status='pending' AND assigned_agent_id IS NULL;
CREATE OR REPLACE FUNCTION wacrm.sweepable_flow_runs(p_limit integer DEFAULT 200)
RETURNS TABLE(id uuid,flow_id uuid,user_id uuid,contact_id uuid,last_advanced_at timestamptz,flows jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT r.id,r.flow_id,r.user_id,r.contact_id,r.last_advanced_at,
 jsonb_build_object('fallback_policy',f.fallback_policy)
 FROM wacrm.flow_runs r JOIN wacrm.flows f ON f.id=r.flow_id
 WHERE r.status='active' AND r.last_advanced_at < clock_timestamp() - (
   CASE WHEN jsonb_typeof(f.fallback_policy->'on_timeout_hours')='number'
     THEN CASE WHEN (f.fallback_policy->>'on_timeout_hours')::numeric>0
       THEN (f.fallback_policy->>'on_timeout_hours')::numeric ELSE 24 END
     ELSE 24 END * interval '1 hour')
 ORDER BY r.last_advanced_at LIMIT least(200,greatest(1,p_limit));
$$;
REVOKE ALL ON FUNCTION wacrm.renew_cron_lock(text,text),wacrm.sweepable_flow_runs(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION wacrm.renew_cron_lock(text,text),wacrm.sweepable_flow_runs(integer) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
