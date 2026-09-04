-- ============================================================
-- 072_message_logs.sql — documents wacrm.message_logs.
--
-- Documents a table already created directly in production
-- (confirmed live via the REST OpenAPI schema — not run by this
-- session, no prior migration file covered it): processQueueItem
-- (src/lib/disparador/processQueue.ts) inserts one row per Disparador
-- send, but until now the table didn't exist in any schema — every
-- insert failed with PGRST205 ("Could not find the table
-- 'wacrm.message_logs'"), silently, since the insert's result was
-- never checked. This file exists so a fresh environment (or a
-- rebuilt one) ends up with the same table, indexes, and RLS shape
-- that production already has.
--
-- Columns match processQueueItem's insert shape exactly: queue_id,
-- campaign_id, contact_id, session_id are plain UUID columns with no
-- FK constraint (confirmed live — none of them carry a "Foreign Key"
-- note in the OpenAPI schema, unlike e.g. disp_message_queue.contact_id
-- which does reference contacts.id). Not adding FKs here that don't
-- exist live.
--
-- RLS: wacrm.campaigns has NO account_id column yet (migration 040,
-- "DO NOT APPLY" until the app's insert paths are updated — still not
-- applied as of this writing), so message_logs_select can't join
-- straight to campaigns.account_id. It resolves the account the same
-- interim way migration 040's own backfill does: campaigns.created_by
-- -> profiles.user_id -> profiles.account_id.
--
-- Idempotent — safe to run multiple times. File only, NOT applied to
-- the database by this session (already live).
-- ============================================================

SET search_path TO wacrm, public, extensions;

CREATE TABLE IF NOT EXISTS wacrm.message_logs (
  id                uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  queue_id          uuid,
  campaign_id       uuid,
  contact_id        uuid,
  session_id        uuid,
  direcao           text DEFAULT 'saida',
  mensagem          text,
  status            text DEFAULT 'enviado',
  waha_message_id   text,
  created_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_logs_campaign_id_idx
  ON wacrm.message_logs (campaign_id);

CREATE INDEX IF NOT EXISTS message_logs_queue_id_idx
  ON wacrm.message_logs (queue_id);

CREATE INDEX IF NOT EXISTS message_logs_created_at_idx
  ON wacrm.message_logs (created_at DESC);

ALTER TABLE wacrm.message_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.message_logs FORCE ROW LEVEL SECURITY;

-- Re-runnable: CREATE POLICY has no IF NOT EXISTS, so drop first.
DROP POLICY IF EXISTS message_logs_select ON wacrm.message_logs;

-- Membership check goes through campaigns.created_by -> profiles,
-- not campaigns.account_id (doesn't exist yet — see note above).
-- Rows whose campaign_id doesn't resolve to an account this way
-- (NULL campaign_id, NULL created_by, or an unresolvable profile) are
-- invisible to everyone, same "hidden, not deleted" trade-off
-- migration 040 already accepted for the sibling disparador tables.
CREATE POLICY message_logs_select ON wacrm.message_logs
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM wacrm.campaigns c
      JOIN wacrm.profiles p ON p.user_id = c.created_by
      WHERE c.id = message_logs.campaign_id
        AND is_account_member(p.account_id)
    )
  );

NOTIFY pgrst, 'reload schema';
