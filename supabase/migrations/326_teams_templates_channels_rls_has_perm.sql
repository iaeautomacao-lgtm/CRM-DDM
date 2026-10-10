-- ============================================================
-- 326_teams_templates_channels_rls_has_perm.sql   (RLS fase 2, lote L4 — equipes, templates, canais auxiliares e conta pelo catálogo; equivalência EXATA nos papéis de sistema)
--
-- Todas estas leituras eram "é membro da conta?" (qualquer papel). As chaves abaixo são concedidas a TODOS os papéis de sistema (permissions.ts: roles: ALL),
-- então acrescentar `AND (SELECT wacrm.has_perm('<chave>'))` não muda o que nenhum papel de sistema lê; só um papel PERSONALIZADO sem a chave deixa de ler.
--   teams, team_members, team_allowed_templates, team_outcome_tags   teams.view
--   message_templates, disparador_message_templates                  templates.view
--   clients, whatsapp_test_sends                                     channels.view
--   accounts                                                         account.view
-- clients_write (FOR ALL, admin) TAMBÉM concedia SELECT: vira INSERT/UPDATE/DELETE com a MESMA condição de hoje (admin+), e a leitura passa a depender só de
-- clients_select. As demais tabelas têm escrita em policies separadas (não-ALL). profiles (linhas e e-mail) NÃO entra aqui: é da migration 305 (Cinzel).
--
-- SEGURANÇA DA TROCA: has_perm é fail-closed (perfil sem role_id = false). Com QUALQUER perfil sem role_id a migration ABORTA sem alterar nada
-- (accounts é lida no boot do app: quem ficasse sem role_id perderia a própria organização).
--
-- PRÉ-CHECK:  SELECT count(*) FROM wacrm.profiles WHERE role_id IS NULL;                                                              -- 0 (senão aborta)
--             SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname='wacrm' AND tablename IN ('teams','team_members','team_allowed_templates','team_outcome_tags','message_templates','disparador_message_templates','clients','whatsapp_test_sends','accounts') AND cmd IN ('SELECT','ALL') ORDER BY 1,2;
--             SELECT key FROM wacrm.permission_catalog WHERE key IN ('teams.view','templates.view','channels.view','account.view');   -- 4 linhas
-- VERIFICAÇÃO: como visualizador (JWT), SELECT count(*) FROM wacrm.teams → igual a antes; o app abre normalmente (accounts).
-- ORDEM: antes ou depois do deploy (o app não depende dela). Idempotente.
-- ROLLBACK:   BEGIN;
--             DROP POLICY IF EXISTS teams_select ON wacrm.teams;
--             CREATE POLICY teams_select ON wacrm.teams FOR SELECT USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS team_members_select ON wacrm.team_members;
--             CREATE POLICY team_members_select ON wacrm.team_members FOR SELECT USING (auth.uid() IN (SELECT p.user_id FROM wacrm.profiles p JOIN wacrm.teams t ON t.id = team_members.team_id WHERE p.account_id = t.account_id));
--             DROP POLICY IF EXISTS team_allowed_templates_select ON wacrm.team_allowed_templates;
--             CREATE POLICY team_allowed_templates_select ON wacrm.team_allowed_templates FOR SELECT USING (auth.uid() IN (SELECT p.user_id FROM wacrm.profiles p JOIN wacrm.teams t ON t.id = team_allowed_templates.team_id WHERE p.account_id = t.account_id));
--             DROP POLICY IF EXISTS team_outcome_tags_select ON wacrm.team_outcome_tags;
--             CREATE POLICY team_outcome_tags_select ON wacrm.team_outcome_tags FOR SELECT USING (auth.uid() IN (SELECT p.user_id FROM wacrm.profiles p JOIN wacrm.teams t ON t.id = team_outcome_tags.team_id WHERE p.account_id = t.account_id));
--             DROP POLICY IF EXISTS message_templates_select ON wacrm.message_templates;
--             CREATE POLICY message_templates_select ON wacrm.message_templates FOR SELECT USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS disparador_message_templates_select ON wacrm.disparador_message_templates;
--             CREATE POLICY disparador_message_templates_select ON wacrm.disparador_message_templates FOR SELECT USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS clients_select ON wacrm.clients;
--             DROP POLICY IF EXISTS clients_insert ON wacrm.clients;
--             DROP POLICY IF EXISTS clients_update ON wacrm.clients;
--             DROP POLICY IF EXISTS clients_delete ON wacrm.clients;
--             DROP POLICY IF EXISTS clients_write ON wacrm.clients;
--             CREATE POLICY clients_select ON wacrm.clients FOR SELECT TO authenticated USING (wacrm.is_account_member(account_id));
--             CREATE POLICY clients_write ON wacrm.clients FOR ALL TO authenticated USING (wacrm.is_account_member(account_id, 'admin')) WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
--             DROP POLICY IF EXISTS whatsapp_test_sends_select ON wacrm.whatsapp_test_sends;
--             CREATE POLICY whatsapp_test_sends_select ON wacrm.whatsapp_test_sends FOR SELECT USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS accounts_select ON wacrm.accounts;
--             CREATE POLICY accounts_select ON wacrm.accounts FOR SELECT USING (wacrm.is_account_member(id));
--             DELETE FROM wacrm.schema_migrations WHERE version = '326_teams_templates_channels_rls_has_perm';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_orphans integer;
  t text;
BEGIN
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '326: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  IF (SELECT count(*) FROM wacrm.permission_catalog WHERE key IN ('teams.view', 'templates.view', 'channels.view', 'account.view')) <> 4 THEN
    RAISE EXCEPTION '326: faltam chaves no catálogo (teams.view, templates.view, channels.view, account.view — migration 240)';
  END IF;
  FOREACH t IN ARRAY ARRAY['teams', 'team_members', 'team_allowed_templates', 'team_outcome_tags', 'message_templates', 'disparador_message_templates', 'clients', 'whatsapp_test_sends', 'accounts'] LOOP
    IF to_regclass('wacrm.' || t) IS NULL THEN
      RAISE EXCEPTION '326: falta wacrm.% — confira o schema vivo', t;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_orphans FROM wacrm.profiles WHERE role_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '326: % perfil(is) sem role_id perderiam estas leituras (has_perm é fail-closed) — preencha o role_id antes. Nada foi alterado.', v_orphans;
  END IF;
END $$;

-- ---- equipes (teams.view) ----------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS teams_select ON wacrm.teams;
CREATE POLICY teams_select ON wacrm.teams FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('teams.view'))
);

DROP POLICY IF EXISTS team_members_select ON wacrm.team_members;
CREATE POLICY team_members_select ON wacrm.team_members FOR SELECT USING (
  auth.uid() IN (SELECT p.user_id FROM wacrm.profiles p JOIN wacrm.teams t ON t.id = team_members.team_id WHERE p.account_id = t.account_id)
  AND (SELECT wacrm.has_perm('teams.view'))
);

DROP POLICY IF EXISTS team_allowed_templates_select ON wacrm.team_allowed_templates;
CREATE POLICY team_allowed_templates_select ON wacrm.team_allowed_templates FOR SELECT USING (
  auth.uid() IN (SELECT p.user_id FROM wacrm.profiles p JOIN wacrm.teams t ON t.id = team_allowed_templates.team_id WHERE p.account_id = t.account_id)
  AND (SELECT wacrm.has_perm('teams.view'))
);

DROP POLICY IF EXISTS team_outcome_tags_select ON wacrm.team_outcome_tags;
CREATE POLICY team_outcome_tags_select ON wacrm.team_outcome_tags FOR SELECT USING (
  auth.uid() IN (SELECT p.user_id FROM wacrm.profiles p JOIN wacrm.teams t ON t.id = team_outcome_tags.team_id WHERE p.account_id = t.account_id)
  AND (SELECT wacrm.has_perm('teams.view'))
);

-- ---- templates (templates.view) ----------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS message_templates_select ON wacrm.message_templates;
CREATE POLICY message_templates_select ON wacrm.message_templates FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('templates.view'))
);

DROP POLICY IF EXISTS disparador_message_templates_select ON wacrm.disparador_message_templates;
CREATE POLICY disparador_message_templates_select ON wacrm.disparador_message_templates FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('templates.view'))
);

-- ---- canais auxiliares (channels.view); clients_write (FOR ALL) também lia: separa em escrita (mesma condição) e leitura ------
DROP POLICY IF EXISTS clients_select ON wacrm.clients;
DROP POLICY IF EXISTS clients_write ON wacrm.clients;
DROP POLICY IF EXISTS clients_insert ON wacrm.clients;
DROP POLICY IF EXISTS clients_update ON wacrm.clients;
DROP POLICY IF EXISTS clients_delete ON wacrm.clients;
CREATE POLICY clients_select ON wacrm.clients FOR SELECT TO authenticated USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('channels.view'))
);
CREATE POLICY clients_insert ON wacrm.clients FOR INSERT TO authenticated WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
CREATE POLICY clients_update ON wacrm.clients FOR UPDATE TO authenticated USING (wacrm.is_account_member(account_id, 'admin')) WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
CREATE POLICY clients_delete ON wacrm.clients FOR DELETE TO authenticated USING (wacrm.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_test_sends_select ON wacrm.whatsapp_test_sends;
CREATE POLICY whatsapp_test_sends_select ON wacrm.whatsapp_test_sends FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('channels.view'))
);

-- ---- conta (account.view) ----------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS accounts_select ON wacrm.accounts;
CREATE POLICY accounts_select ON wacrm.accounts FOR SELECT USING (
  wacrm.is_account_member(id) AND (SELECT wacrm.has_perm('account.view'))
);

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('326_teams_templates_channels_rls_has_perm') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
