-- ============================================================
-- 336_contacts_write_rls_has_perm.sql   (revisão de segurança 13/10, item 8 — RLS fase 3, escrita: contatos e filhas)
--
-- Escrita de contatos pelo PostgREST só exigia "membro com papel >= agent" (017/087) e as filhas contact_tags / contact_custom_values tinham uma policy FOR ALL
-- ("..._modify") que, além de escrever, CONCEDIA SELECT por papel — anulando a leitura por permissão da 323. Passa a decidir pelo catálogo (has_perm), com a MESMA regra
-- de conta (membro da conta do contato):
--   contacts, contact_notes, contact_phones, contact_tags, contact_custom_values   INSERT/UPDATE/DELETE  →  contacts.edit        (agent+ nos papéis de sistema: o que cada um escreve não muda)
--   custom_fields, tags                                                            INSERT/UPDATE/DELETE  →  tags.manage         (admin+ nos papéis de sistema: não muda)
-- As telas já usam exatamente estas chaves (contacts/page.tsx: contacts.edit e tags.manage), então nenhuma tela dos papéis de sistema muda. Só o papel PERSONALIZADO passa a
-- escrever pelo que o catálogo diz (antes valia o compat_role): com contacts.edit escreve, sem contacts.edit não escreve.
-- contact_tags_modify e contact_custom_values_modify (FOR ALL) são trocadas por INSERT/UPDATE/DELETE: a leitura vem só das policies *_select por permissão (323).
-- Servidor (service_role) não passa por RLS: webhooks, importação e fluxos seguem iguais. contact_identities e contact_import_variables já são só-leitura para o navegador (128/170).
--
-- SEGURANÇA DA TROCA: has_perm é fail-closed (perfil sem role_id = false) → a migration ABORTA, sem alterar nada, se houver perfil sem role_id.
--
-- PRÉ-CHECK:  SELECT count(*) FROM wacrm.profiles WHERE role_id IS NULL;                                                              -- 0 (senão aborta)
--             SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'wacrm' AND tablename IN ('contacts','contact_notes','contact_phones','contact_tags','contact_custom_values','custom_fields','tags') AND cmd <> 'SELECT' ORDER BY 1,2;
--             SELECT key FROM wacrm.permission_catalog WHERE key IN ('contacts.edit','tags.manage');                                  -- 2 linhas
-- VERIFICAÇÃO: como operador (JWT): criar/editar contato, nota, telefone, tag e campo personalizado pelo CRM continua funcionando; como visualizador, INSERT em wacrm.contacts → "violates row-level security".
-- ORDEM: antes ou depois do deploy (o app não depende dela). Idempotente.
-- ROLLBACK:   BEGIN;
--             DROP POLICY IF EXISTS contacts_insert ON wacrm.contacts;
--             DROP POLICY IF EXISTS contacts_update ON wacrm.contacts;
--             DROP POLICY IF EXISTS contacts_delete ON wacrm.contacts;
--             CREATE POLICY contacts_insert ON wacrm.contacts FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY contacts_update ON wacrm.contacts FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY contacts_delete ON wacrm.contacts FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));
--             DROP POLICY IF EXISTS contact_notes_insert ON wacrm.contact_notes;
--             DROP POLICY IF EXISTS contact_notes_update ON wacrm.contact_notes;
--             DROP POLICY IF EXISTS contact_notes_delete ON wacrm.contact_notes;
--             CREATE POLICY contact_notes_insert ON wacrm.contact_notes FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY contact_notes_update ON wacrm.contact_notes FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY contact_notes_delete ON wacrm.contact_notes FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));
--             DROP POLICY IF EXISTS contact_phones_insert ON wacrm.contact_phones;
--             DROP POLICY IF EXISTS contact_phones_update ON wacrm.contact_phones;
--             DROP POLICY IF EXISTS contact_phones_delete ON wacrm.contact_phones;
--             CREATE POLICY contact_phones_insert ON wacrm.contact_phones FOR INSERT WITH CHECK (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id, 'agent')));
--             CREATE POLICY contact_phones_update ON wacrm.contact_phones FOR UPDATE USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id, 'agent')));
--             CREATE POLICY contact_phones_delete ON wacrm.contact_phones FOR DELETE USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id, 'agent')));
--             DROP POLICY IF EXISTS contact_tags_insert ON wacrm.contact_tags;
--             DROP POLICY IF EXISTS contact_tags_update ON wacrm.contact_tags;
--             DROP POLICY IF EXISTS contact_tags_delete ON wacrm.contact_tags;
--             DROP POLICY IF EXISTS contact_tags_modify ON wacrm.contact_tags;
--             CREATE POLICY contact_tags_modify ON wacrm.contact_tags FOR ALL USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id, 'agent'))) WITH CHECK (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id, 'agent')));
--             DROP POLICY IF EXISTS contact_custom_values_insert ON wacrm.contact_custom_values;
--             DROP POLICY IF EXISTS contact_custom_values_update ON wacrm.contact_custom_values;
--             DROP POLICY IF EXISTS contact_custom_values_delete ON wacrm.contact_custom_values;
--             DROP POLICY IF EXISTS contact_custom_values_modify ON wacrm.contact_custom_values;
--             CREATE POLICY contact_custom_values_modify ON wacrm.contact_custom_values FOR ALL USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id, 'agent'))) WITH CHECK (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id, 'agent')));
--             DROP POLICY IF EXISTS custom_fields_insert ON wacrm.custom_fields;
--             DROP POLICY IF EXISTS custom_fields_update ON wacrm.custom_fields;
--             DROP POLICY IF EXISTS custom_fields_delete ON wacrm.custom_fields;
--             CREATE POLICY custom_fields_insert ON wacrm.custom_fields FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
--             CREATE POLICY custom_fields_update ON wacrm.custom_fields FOR UPDATE USING (wacrm.is_account_member(account_id, 'admin'));
--             CREATE POLICY custom_fields_delete ON wacrm.custom_fields FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));
--             DROP POLICY IF EXISTS tags_insert ON wacrm.tags;
--             DROP POLICY IF EXISTS tags_update ON wacrm.tags;
--             DROP POLICY IF EXISTS tags_delete ON wacrm.tags;
--             CREATE POLICY tags_insert ON wacrm.tags FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
--             CREATE POLICY tags_update ON wacrm.tags FOR UPDATE USING (wacrm.is_account_member(account_id, 'admin'));
--             CREATE POLICY tags_delete ON wacrm.tags FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));
--             DELETE FROM wacrm.schema_migrations WHERE version = '336_contacts_write_rls_has_perm';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_orphans integer;
  t text;
BEGIN
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '336: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  IF (SELECT count(*) FROM wacrm.permission_catalog WHERE key IN ('contacts.edit', 'tags.manage')) <> 2 THEN
    RAISE EXCEPTION '336: faltam chaves no catálogo (contacts.edit, tags.manage — migration 240)';
  END IF;
  FOREACH t IN ARRAY ARRAY['contacts', 'contact_notes', 'contact_phones', 'contact_tags', 'contact_custom_values', 'custom_fields', 'tags'] LOOP
    IF to_regclass('wacrm.' || t) IS NULL THEN
      RAISE EXCEPTION '336: falta wacrm.% — confira o schema vivo', t;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_orphans FROM wacrm.profiles WHERE role_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '336: % perfil(is) sem role_id perderiam a escrita (has_perm é fail-closed) — preencha o role_id antes. Nada foi alterado.', v_orphans;
  END IF;
END $$;

-- ---- contacts (membro da conta + contacts.edit) --------------------------------------------------------------------------------
DROP POLICY IF EXISTS contacts_insert ON wacrm.contacts;
DROP POLICY IF EXISTS contacts_update ON wacrm.contacts;
DROP POLICY IF EXISTS contacts_delete ON wacrm.contacts;
CREATE POLICY contacts_insert ON wacrm.contacts FOR INSERT WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.edit')));
CREATE POLICY contacts_update ON wacrm.contacts FOR UPDATE USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.edit')))
  WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.edit')));
CREATE POLICY contacts_delete ON wacrm.contacts FOR DELETE USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.edit')));

-- ---- contact_notes ---------------------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS contact_notes_insert ON wacrm.contact_notes;
DROP POLICY IF EXISTS contact_notes_update ON wacrm.contact_notes;
DROP POLICY IF EXISTS contact_notes_delete ON wacrm.contact_notes;
CREATE POLICY contact_notes_insert ON wacrm.contact_notes FOR INSERT WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.edit')));
CREATE POLICY contact_notes_update ON wacrm.contact_notes FOR UPDATE USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.edit')))
  WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.edit')));
CREATE POLICY contact_notes_delete ON wacrm.contact_notes FOR DELETE USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.edit')));

-- ---- contact_phones (conta pelo contato) -----------------------------------------------------------------------------------------
DROP POLICY IF EXISTS contact_phones_insert ON wacrm.contact_phones;
DROP POLICY IF EXISTS contact_phones_update ON wacrm.contact_phones;
DROP POLICY IF EXISTS contact_phones_delete ON wacrm.contact_phones;
CREATE POLICY contact_phones_insert ON wacrm.contact_phones FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id)) AND (SELECT wacrm.has_perm('contacts.edit'))
);
CREATE POLICY contact_phones_update ON wacrm.contact_phones FOR UPDATE USING (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id)) AND (SELECT wacrm.has_perm('contacts.edit'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id)) AND (SELECT wacrm.has_perm('contacts.edit'))
);
CREATE POLICY contact_phones_delete ON wacrm.contact_phones FOR DELETE USING (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id)) AND (SELECT wacrm.has_perm('contacts.edit'))
);

-- ---- contact_tags e contact_custom_values: a FOR ALL (que também lia por papel) vira INSERT/UPDATE/DELETE --------------------------
DROP POLICY IF EXISTS contact_tags_modify ON wacrm.contact_tags;
DROP POLICY IF EXISTS contact_tags_insert ON wacrm.contact_tags;
DROP POLICY IF EXISTS contact_tags_update ON wacrm.contact_tags;
DROP POLICY IF EXISTS contact_tags_delete ON wacrm.contact_tags;
CREATE POLICY contact_tags_insert ON wacrm.contact_tags FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id)) AND (SELECT wacrm.has_perm('contacts.edit'))
);
CREATE POLICY contact_tags_update ON wacrm.contact_tags FOR UPDATE USING (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id)) AND (SELECT wacrm.has_perm('contacts.edit'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id)) AND (SELECT wacrm.has_perm('contacts.edit'))
);
CREATE POLICY contact_tags_delete ON wacrm.contact_tags FOR DELETE USING (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id)) AND (SELECT wacrm.has_perm('contacts.edit'))
);

DROP POLICY IF EXISTS contact_custom_values_modify ON wacrm.contact_custom_values;
DROP POLICY IF EXISTS contact_custom_values_insert ON wacrm.contact_custom_values;
DROP POLICY IF EXISTS contact_custom_values_update ON wacrm.contact_custom_values;
DROP POLICY IF EXISTS contact_custom_values_delete ON wacrm.contact_custom_values;
CREATE POLICY contact_custom_values_insert ON wacrm.contact_custom_values FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id)) AND (SELECT wacrm.has_perm('contacts.edit'))
);
CREATE POLICY contact_custom_values_update ON wacrm.contact_custom_values FOR UPDATE USING (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id)) AND (SELECT wacrm.has_perm('contacts.edit'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id)) AND (SELECT wacrm.has_perm('contacts.edit'))
);
CREATE POLICY contact_custom_values_delete ON wacrm.contact_custom_values FOR DELETE USING (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id)) AND (SELECT wacrm.has_perm('contacts.edit'))
);

-- ---- custom_fields e tags (tags.manage) -----------------------------------------------------------------------------------------
DROP POLICY IF EXISTS custom_fields_insert ON wacrm.custom_fields;
DROP POLICY IF EXISTS custom_fields_update ON wacrm.custom_fields;
DROP POLICY IF EXISTS custom_fields_delete ON wacrm.custom_fields;
CREATE POLICY custom_fields_insert ON wacrm.custom_fields FOR INSERT WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('tags.manage')));
CREATE POLICY custom_fields_update ON wacrm.custom_fields FOR UPDATE USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('tags.manage')))
  WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('tags.manage')));
CREATE POLICY custom_fields_delete ON wacrm.custom_fields FOR DELETE USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('tags.manage')));

DROP POLICY IF EXISTS tags_insert ON wacrm.tags;
DROP POLICY IF EXISTS tags_update ON wacrm.tags;
DROP POLICY IF EXISTS tags_delete ON wacrm.tags;
CREATE POLICY tags_insert ON wacrm.tags FOR INSERT WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('tags.manage')));
CREATE POLICY tags_update ON wacrm.tags FOR UPDATE USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('tags.manage')))
  WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('tags.manage')));
CREATE POLICY tags_delete ON wacrm.tags FOR DELETE USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('tags.manage')));

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('336_contacts_write_rls_has_perm') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
