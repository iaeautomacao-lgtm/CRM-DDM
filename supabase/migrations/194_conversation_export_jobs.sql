-- 194_conversation_export_jobs.sql
-- Private, resumable conversation-history exports. Apply BEFORE app deploy.
BEGIN;
SET search_path TO wacrm, public, extensions;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('conversation-history-exports','conversation-history-exports',false,52428800,ARRAY['application/gzip'])
ON CONFLICT (id) DO UPDATE SET public=false,file_size_limit=EXCLUDED.file_size_limit,allowed_mime_types=EXCLUDED.allowed_mime_types;
-- Intentionally NO authenticated/anon SELECT/INSERT/UPDATE/DELETE policies.
-- Only service_role writes/signs. Public API verifies account_id + scope.

CREATE TABLE IF NOT EXISTS wacrm.conversation_export_jobs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
 created_by_key_id uuid NOT NULL,
 filters jsonb NOT NULL DEFAULT '{}'::jsonb,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','expired')),
 snapshot_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
 next_run_at timestamptz NOT NULL DEFAULT now(),
 lease_token uuid,
 lease_expires_at timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 conversation_cursor text,
 message_cursor text,
 parts_count integer NOT NULL DEFAULT 0,
 conversations_exported integer NOT NULL DEFAULT 0,
 messages_exported integer NOT NULL DEFAULT 0,
 error_code text,
 started_at timestamptz,
 completed_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT conversation_export_parts_positive CHECK (parts_count>=0 AND conversations_exported>=0 AND messages_exported>=0)
);
CREATE INDEX IF NOT EXISTS conversation_export_job_due_idx
 ON wacrm.conversation_export_jobs(next_run_at,created_at)
 WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS conversation_export_job_account_idx
 ON wacrm.conversation_export_jobs(account_id,created_at DESC);

CREATE TABLE IF NOT EXISTS wacrm.conversation_export_parts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 job_id uuid NOT NULL REFERENCES wacrm.conversation_export_jobs(id) ON DELETE CASCADE,
 account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
 part_no integer NOT NULL CHECK (part_no >= 1),
 storage_path text NOT NULL,
 byte_size bigint NOT NULL CHECK (byte_size>=0),
 messages_count integer NOT NULL DEFAULT 0,
 conversations_count integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(job_id,part_no)
);
CREATE INDEX IF NOT EXISTS conversation_export_part_account_idx
 ON wacrm.conversation_export_parts(account_id,job_id,part_no);

ALTER TABLE wacrm.conversation_export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.conversation_export_parts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.conversation_export_jobs FROM anon, authenticated, PUBLIC;
REVOKE ALL ON wacrm.conversation_export_parts FROM anon, authenticated, PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON wacrm.conversation_export_jobs TO service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON wacrm.conversation_export_parts TO service_role;

-- Atomic lease and bounded retries, even when cPanel cron invocations overlap.
CREATE OR REPLACE FUNCTION wacrm.claim_conversation_export_job()
RETURNS SETOF wacrm.conversation_export_jobs
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=wacrm,public,extensions
AS $$
BEGIN
  UPDATE wacrm.conversation_export_jobs
  SET status='failed',error_code='max_retries', lease_token=NULL,lease_expires_at=NULL,updated_at=now()
  WHERE status IN ('queued','running') AND attempts>=5
    AND (lease_expires_at IS NULL OR lease_expires_at<now());
  RETURN QUERY
  WITH candidate AS (
    SELECT j.id FROM wacrm.conversation_export_jobs j
    WHERE j.status IN ('queued','running')
      AND j.attempts<5
      AND j.expires_at>now()
      AND j.next_run_at<=now()
      AND (j.lease_expires_at IS NULL OR j.lease_expires_at<now())
    ORDER BY j.next_run_at,j.created_at
    FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE wacrm.conversation_export_jobs j
  SET status='running',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '5 minutes',
      attempts=j.attempts+1,started_at=coalesce(j.started_at,now()),updated_at=now()
  FROM candidate WHERE j.id=candidate.id
  RETURNING j.*;
END $$;
REVOKE ALL ON FUNCTION wacrm.claim_conversation_export_job() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION wacrm.claim_conversation_export_job() TO service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
