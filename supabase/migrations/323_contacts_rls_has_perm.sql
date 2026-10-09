-- ============================================================
-- 323_contacts_rls_has_perm.sql   (RLS fase 2, lote L1 — contatos pelo catálogo: contacts.view; equivalência EXATA para os papéis de sistema)
--
-- Hoje as policies de SELECT de contatos só perguntam "é membro da conta?" (`is_account_member(account_id)`): qualquer papel, inclusive o
-- visualizador, lê contatos (CPF, telefone, e-mail) por consulta direta. A permissão `contacts.view` do catálogo é concedida a TODOS os papéis
-- de sistema (permissions.ts: roles: ALL), então acrescentar `AND (SELECT wacrm.has_perm('contacts.view'))` NÃO muda o que nenhum papel de
-- sistema lê. O que muda: um papel PERSONALIZADO só lê contatos se tiver `contacts.view` (o editor já obriga `contacts.view` junto de
-- `contacts.edit`/`contacts.import`).
--
-- Tabelas (todas as que o navegador lê, ver rls-has-perm-fase2.md §2.1): contacts, contact_tags, contact_custom_values, contact_import_variables,
-- contact_phones, contact_notes, contact_identities, tags, custom_fields. A expressão antiga é MANTIDA e o termo de permissão é acrescentado
-- como `(SELECT …)` (initplan: uma avaliação por consulta, não por linha — padrão da 220). As policies FOR ALL (`contact_tags_modify`,
-- `contact_custom_values_modify`) consultam `contacts` por subconsulta, então herdam a nova regra da tabela-mãe; as de escrita não mudam.
--
-- SEGURANÇA DA TROCA: `has_perm` é fail-closed (perfil sem `role_id` = false). Se houver QUALQUER perfil sem role_id, esta migration ABORTA
-- sem alterar nada (essa pessoa perderia todos os contatos). Corrija antes: o backfill da 240 / trigger profiles_sync_role.
--
-- PRÉ-CHECK:  SELECT count(*) FROM wacrm.profiles WHERE role_id IS NULL;                                  -- 0 (senão a migration aborta)
--             SELECT to_regprocedure('wacrm.has_perm(text)');                                              -- não nulo (241)
--             SELECT key FROM wacrm.permission_catalog WHERE key = 'contacts.view';                        -- 1 linha (240)
--             SELECT tablename, policyname, qual FROM pg_policies WHERE schemaname = 'wacrm'
--              AND tablename IN ('contacts','contact_tags','contact_custom_values','contact_import_variables','contact_phones','contact_notes','contact_identities','tags','custom_fields')
--              AND cmd = 'SELECT';   -- conferir que a expressão viva é só is_account_member (se tiver mais coisa, NÃO rodar: ver prd-v2/rls-p0.sql)
-- VERIFICAÇÃO (logado como visualizador, que hoje lê): SELECT count(*) FROM wacrm.contacts;  → igual a antes da migration.
-- ORDEM: antes ou depois do deploy (o app não depende dela). Idempotente.
-- ROLLBACK:   BEGIN;
--             DROP POLICY IF EXISTS contacts_select ON wacrm.contacts;
--             CREATE POLICY contacts_select ON wacrm.contacts FOR SELECT USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS tags_select ON wacrm.tags;
--             CREATE POLICY tags_select ON wacrm.tags FOR SELECT USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS custom_fields_select ON wacrm.custom_fields;
--             CREATE POLICY custom_fields_select ON wacrm.custom_fields FOR SELECT USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS contact_notes_select ON wacrm.contact_notes;
--             CREATE POLICY contact_notes_select ON wacrm.contact_notes FOR SELECT USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS contact_identities_select ON wacrm.contact_identities;
--             CREATE POLICY contact_identities_select ON wacrm.contact_identities FOR SELECT TO authenticated USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS contact_tags_select ON wacrm.contact_tags;
--             CREATE POLICY contact_tags_select ON wacrm.contact_tags FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id)));
--             DROP POLICY IF EXISTS contact_custom_values_select ON wacrm.contact_custom_values;
--             CREATE POLICY contact_custom_values_select ON wacrm.contact_custom_values FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id)));
--             DROP POLICY IF EXISTS contact_phones_select ON wacrm.contact_phones;
--             CREATE POLICY contact_phones_select ON wacrm.contact_phones FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id)));
--             DROP POLICY IF EXISTS contact_import_variables_select ON wacrm.contact_import_variables;
--             CREATE POLICY contact_import_variables_select ON wacrm.contact_import_variables FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_import_variables.contact_id AND wacrm.is_account_member(c.account_id)));
--             DELETE FROM wacrm.schema_migrations WHERE version = '323_contacts_rls_has_perm';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_orphans integer;
  t text;
BEGIN
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '323: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM wacrm.permission_catalog WHERE key = 'contacts.view') THEN
    RAISE EXCEPTION '323: contacts.view fora do catálogo (migration 240)';
  END IF;
  FOREACH t IN ARRAY ARRAY['contacts', 'contact_tags', 'contact_custom_values', 'contact_import_variables', 'contact_phones', 'contact_notes', 'contact_identities', 'tags', 'custom_fields'] LOOP
    IF to_regclass('wacrm.' || t) IS NULL THEN
      RAISE EXCEPTION '323: falta wacrm.% — confira o schema vivo', t;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_orphans FROM wacrm.profiles WHERE role_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '323: % perfil(is) sem role_id perderiam todos os contatos (has_perm é fail-closed) — preencha o role_id antes (migration 240/trigger profiles_sync_role). Nada foi alterado.', v_orphans;
  END IF;
END $$;

DROP POLICY IF EXISTS contacts_select ON wacrm.contacts;
CREATE POLICY contacts_select ON wacrm.contacts FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.view'))
);

DROP POLICY IF EXISTS tags_select ON wacrm.tags;
CREATE POLICY tags_select ON wacrm.tags FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.view'))
);

DROP POLICY IF EXISTS custom_fields_select ON wacrm.custom_fields;
CREATE POLICY custom_fields_select ON wacrm.custom_fields FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.view'))
);

DROP POLICY IF EXISTS contact_notes_select ON wacrm.contact_notes;
CREATE POLICY contact_notes_select ON wacrm.contact_notes FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.view'))
);

DROP POLICY IF EXISTS contact_identities_select ON wacrm.contact_identities;
CREATE POLICY contact_identities_select ON wacrm.contact_identities FOR SELECT TO authenticated USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.view'))
);

DROP POLICY IF EXISTS contact_tags_select ON wacrm.contact_tags;
CREATE POLICY contact_tags_select ON wacrm.contact_tags FOR SELECT USING (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_tags.contact_id AND wacrm.is_account_member(c.account_id))
  AND (SELECT wacrm.has_perm('contacts.view'))
);

DROP POLICY IF EXISTS contact_custom_values_select ON wacrm.contact_custom_values;
CREATE POLICY contact_custom_values_select ON wacrm.contact_custom_values FOR SELECT USING (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_custom_values.contact_id AND wacrm.is_account_member(c.account_id))
  AND (SELECT wacrm.has_perm('contacts.view'))
);

DROP POLICY IF EXISTS contact_phones_select ON wacrm.contact_phones;
CREATE POLICY contact_phones_select ON wacrm.contact_phones FOR SELECT USING (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_phones.contact_id AND wacrm.is_account_member(c.account_id))
  AND (SELECT wacrm.has_perm('contacts.view'))
);

DROP POLICY IF EXISTS contact_import_variables_select ON wacrm.contact_import_variables;
CREATE POLICY contact_import_variables_select ON wacrm.contact_import_variables FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM wacrm.contacts c WHERE c.id = contact_import_variables.contact_id AND wacrm.is_account_member(c.account_id))
  AND (SELECT wacrm.has_perm('contacts.view'))
);

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('323_contacts_rls_has_perm') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
