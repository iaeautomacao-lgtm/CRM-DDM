-- 194_public_conversation_exports.sql
-- Private, asynchronous exports of whole conversation transcripts for API keys.
-- Apply BEFORE deploying the /api/v1/conversations/exports routes and cron.
-- Never expose this table through anon/authenticated: service_role only.
SET search_path TO wacrm, public, extensions;

CREATE TABLE IF NOT EXISTS wacrm.conversation_export_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  api_key_id uuid NOT NULL REFERENCES wacrm.api_keys(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_conversations integer NOT NULL DEFAULT 200 CHECK (max_conversations BETWEEN 1 AND 500),
  conversation_count integer NOT NULL DEFAULT 0,
  message_count integer NOT NULL DEFAULT 0,
  event_count integer NOT NULL DEFAULT 0,
  file_bytes bigint,
  storage_path text,
  next_cursor text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX IF NOT EXISTS conversation_export_jobs_queue_idx
  ON wacrm.conversation_export_jobs(created_at)
  WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS conversation_export_jobs_key_idx
  ON wacrm.conversation_export_jobs(account_id, api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS conversation_export_jobs_expiry_idx
  ON wacrm.conversation_export_jobs(expires_at)
  WHERE status IN ('processing','completed');

ALTER TABLE wacrm.conversation_export_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.conversation_export_jobs FROM anon, authenticated;
-- No policies for anon/authenticated; service_role bypasses RLS.

-- Bucket is PRIVATE. Only server/service_role can upload/read/sign links;
-- do not add SELECT policy for authenticated clients on this bucket.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('conversation-api-exports', 'conversation-api-exports', false,
        31457280, ARRAY['application/x-ndjson','application/octet-stream']::text[])
ON CONFLICT (id) DO NOTHING;
