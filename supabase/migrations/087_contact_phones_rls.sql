-- Migration 087: RLS em wacrm.contact_phones.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

ALTER TABLE wacrm.contact_phones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_phones_select ON wacrm.contact_phones;
DROP POLICY IF EXISTS contact_phones_insert ON wacrm.contact_phones;
DROP POLICY IF EXISTS contact_phones_update ON wacrm.contact_phones;
DROP POLICY IF EXISTS contact_phones_delete ON wacrm.contact_phones;

-- Escopa por contact.account_id (contact_phones não tem account_id direto)
CREATE POLICY contact_phones_select ON wacrm.contact_phones
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM wacrm.contacts c
      WHERE c.id = contact_phones.contact_id
        AND wacrm.is_account_member(c.account_id)
    )
  );

CREATE POLICY contact_phones_insert ON wacrm.contact_phones
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM wacrm.contacts c
      WHERE c.id = contact_phones.contact_id
        AND wacrm.is_account_member(c.account_id, 'agent')
    )
  );

CREATE POLICY contact_phones_update ON wacrm.contact_phones
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM wacrm.contacts c
      WHERE c.id = contact_phones.contact_id
        AND wacrm.is_account_member(c.account_id, 'agent')
    )
  );

CREATE POLICY contact_phones_delete ON wacrm.contact_phones
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM wacrm.contacts c
      WHERE c.id = contact_phones.contact_id
        AND wacrm.is_account_member(c.account_id, 'agent')
    )
  );

NOTIFY pgrst, 'reload schema';
