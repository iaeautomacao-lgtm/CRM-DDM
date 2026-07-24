-- ============================================================
-- 042_disparador_message_templates
--
-- Reusable message templates (nome + conteudo) selectable when
-- creating/editing a campaign in the Gerenciador de Campanhas.
--
-- Named wacrm.disparador_message_templates, NOT message_templates —
-- that name is already taken by the Meta WhatsApp Business template
-- catalog (migration 001, extended in 014): a different concept
-- (pre-approved HSM templates synced from Meta, used by the inbox's
-- TemplatePicker), unrelated to this free-text campaign template.
--
-- account_id is set directly (not via created_by), unlike
-- wacrm.campaigns — this table is created after the disparador
-- account-scoping lesson (migration 040), so it starts out right.
-- ============================================================

CREATE TABLE IF NOT EXISTS wacrm.disparador_message_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  conteudo TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_disparador_message_templates_account
  ON wacrm.disparador_message_templates(account_id);

ALTER TABLE wacrm.disparador_message_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS disparador_message_templates_select ON wacrm.disparador_message_templates;
DROP POLICY IF EXISTS disparador_message_templates_insert ON wacrm.disparador_message_templates;
DROP POLICY IF EXISTS disparador_message_templates_update ON wacrm.disparador_message_templates;
DROP POLICY IF EXISTS disparador_message_templates_delete ON wacrm.disparador_message_templates;

CREATE POLICY disparador_message_templates_select ON wacrm.disparador_message_templates
  FOR SELECT USING (wacrm.is_account_member(account_id));
CREATE POLICY disparador_message_templates_insert ON wacrm.disparador_message_templates
  FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
CREATE POLICY disparador_message_templates_update ON wacrm.disparador_message_templates
  FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
CREATE POLICY disparador_message_templates_delete ON wacrm.disparador_message_templates
  FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));

NOTIFY pgrst, 'reload schema';
