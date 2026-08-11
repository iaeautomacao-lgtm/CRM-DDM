-- ============================================================
-- 055_export_history.sql — Exportações: reusable export history,
-- backed by a private Storage bucket + signed URLs.
--
-- First private-bucket + createSignedUrl usage in this codebase
-- (Passo 0: grepped createSignedUrl/getPublicUrl/storage.from across
-- src/ — every existing use is getPublicUrl on a PUBLIC bucket:
-- chat-media, avatars). No prior pattern to diverge from here; this
-- follows the standard Supabase private-bucket + path-scoped RLS
-- shape.
--
-- Write path is server-only: no INSERT/UPDATE/DELETE policy on
-- wacrm.export_history for `authenticated`, matching audit_logs'
-- (050) append-only shape — the API route in
-- src/app/api/relatorios/exports/route.ts writes via the
-- service-role admin client, which bypasses RLS. Same idea for
-- storage.objects: only a SELECT policy exists for authenticated
-- (needed for createSignedUrl to succeed from the browser client);
-- upload/delete on the bucket happens through that same admin client.
--
-- Idempotent — safe to run multiple times. Not applied to the DB by
-- this session; file only.
-- ============================================================

SET search_path TO wacrm, public, extensions;

-- ── 1. Storage bucket ──────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'relatorio-exports',
  'relatorio-exports',
  false, -- private: access only via signed URL
  52428800, -- 50MB
  ARRAY[
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'application/octet-stream'
  ]
) ON CONFLICT (id) DO NOTHING;

-- Any account member may read (createSignedUrl needs this) objects
-- under the folder matching their own account_id — storage_path is
-- always "{account_id}/{id}.{ext}" (see export_history below), so
-- storage.foldername(name)[1] is that first path segment.
DROP POLICY IF EXISTS "account members read exports" ON storage.objects;
CREATE POLICY "account members read exports"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'relatorio-exports'
    AND EXISTS (
      SELECT 1 FROM wacrm.profiles p
      WHERE p.user_id = auth.uid()
        AND (storage.foldername(name))[1] = p.account_id::text
    )
  );

-- No INSERT/UPDATE/DELETE policy for authenticated — upload/remove
-- only happen server-side via the service-role admin client.

-- ── 2. History table ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS wacrm.export_history (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    UUID        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  user_id       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  user_name     TEXT,                 -- snapshot at export time
  export_type   TEXT        NOT NULL, -- 'conversas' | 'envio-em-lote' | 'atendimentos'
  description   TEXT        NOT NULL, -- "Conversas - 01/07 a 04/07/2026"
  period_from   TIMESTAMPTZ,
  period_to     TIMESTAMPTZ,
  file_name     TEXT        NOT NULL, -- e.g. "conversas_2026-08-10.xlsx"
  storage_path  TEXT        NOT NULL, -- "{account_id}/{id}.{ext}"
  file_size     BIGINT,
  status        TEXT        NOT NULL DEFAULT 'completed',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS export_history_account_created
  ON wacrm.export_history(account_id, created_at DESC);

ALTER TABLE wacrm.export_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS export_history_select ON wacrm.export_history;
CREATE POLICY export_history_select
  ON wacrm.export_history FOR SELECT
  USING (is_account_member(account_id));

-- No INSERT/UPDATE/DELETE policy — see header. The API route does
-- both via the service-role admin client.

-- ── 3. RPC: list exports ───────────────────────────────────
CREATE OR REPLACE FUNCTION wacrm.get_export_history(
  p_account_id UUID,
  p_search     TEXT DEFAULT NULL
)
RETURNS TABLE (
  id           UUID,
  user_name    TEXT,
  export_type  TEXT,
  description  TEXT,
  period_from  TIMESTAMPTZ,
  period_to    TIMESTAMPTZ,
  file_name    TEXT,
  storage_path TEXT,
  file_size    BIGINT,
  status       TEXT,
  created_at   TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
  SELECT
    id, user_name, export_type, description,
    period_from, period_to, file_name, storage_path,
    file_size, status, created_at
  FROM wacrm.export_history
  WHERE account_id = p_account_id
    AND is_account_member(p_account_id)
    AND (
      p_search IS NULL
      OR description ILIKE '%' || p_search || '%'
      OR user_name ILIKE '%' || p_search || '%'
    )
  ORDER BY created_at DESC
  LIMIT 200;
$$;

ALTER FUNCTION wacrm.get_export_history(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.get_export_history(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.get_export_history(UUID, TEXT) TO authenticated;
