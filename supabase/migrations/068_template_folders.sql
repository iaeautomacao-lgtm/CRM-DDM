-- ============================================================
-- 068_template_folders.sql — folders for message_templates +
-- channel tags, to support the drag & drop folder UI in
-- src/components/settings/template-manager.tsx.
--
-- wacrm.template_folders: one row per folder, account-scoped.
-- message_templates gains folder_id (nullable — "no folder" is a
-- real, first-class state, not just an unset column), position
-- (manual ordering within a folder / the unfiled list), and
-- channel_tags (free-form labels the UI filters by).
--
-- RLS mirrors message_templates (migration 017): any account
-- member can read, only admin+ can write — templates are a
-- settings-class resource (see canEditSettings in
-- src/lib/auth/roles.ts).
--
-- Idempotent — safe to run multiple times. File only, NOT applied
-- to the database by this session (schema was already applied
-- directly; this captures it for other environments).
-- ============================================================

SET search_path TO wacrm, public, extensions;

CREATE TABLE IF NOT EXISTS wacrm.template_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_template_folders_account ON wacrm.template_folders(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON wacrm.template_folders;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON wacrm.template_folders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE wacrm.message_templates
  ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES wacrm.template_folders(id) ON DELETE SET NULL;
ALTER TABLE wacrm.message_templates
  ADD COLUMN IF NOT EXISTS position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE wacrm.message_templates
  ADD COLUMN IF NOT EXISTS channel_tags TEXT[];

CREATE INDEX IF NOT EXISTS idx_message_templates_folder ON wacrm.message_templates(folder_id);

-- ---- RLS ---------------------------------------------------
ALTER TABLE wacrm.template_folders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS template_folders_select ON wacrm.template_folders;
DROP POLICY IF EXISTS template_folders_insert ON wacrm.template_folders;
DROP POLICY IF EXISTS template_folders_update ON wacrm.template_folders;
DROP POLICY IF EXISTS template_folders_delete ON wacrm.template_folders;

CREATE POLICY template_folders_select ON wacrm.template_folders FOR SELECT USING (is_account_member(account_id));
CREATE POLICY template_folders_insert ON wacrm.template_folders FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY template_folders_update ON wacrm.template_folders FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY template_folders_delete ON wacrm.template_folders FOR DELETE USING (is_account_member(account_id, 'admin'));
