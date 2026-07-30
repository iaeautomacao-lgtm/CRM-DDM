-- ============================================================
-- 045_disparador_message_templates_updated_at
--
-- Adds updated_at to wacrm.disparador_message_templates so editing a
-- template (new in this change — see message-template-picker.tsx)
-- can show when it was last touched. Reuses update_updated_at_column()
-- from migration 001, same as wacrm.accounts/flows do.
-- ============================================================

ALTER TABLE wacrm.disparador_message_templates
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DROP TRIGGER IF EXISTS set_updated_at ON wacrm.disparador_message_templates;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON wacrm.disparador_message_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

NOTIFY pgrst, 'reload schema';
