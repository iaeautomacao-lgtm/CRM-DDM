-- ============================================================
-- 325_audit_admin_tables_rls_has_perm.sql   (RLS fase 2, lote L3 — auditoria, tool-calls, versões de prompt, convites e respostas rápidas pelo catálogo)
--
-- Estas policies decidiam pelo PAPEL mínimo ou pelo nome do papel (`p.account_role IN ('owner','admin')`, `is_account_member(…, 'admin')`): um papel personalizado
-- herdava o compat_role (o menor papel de sistema que contém todas as permissões dele) e lia o que só uma permissão específica deveria liberar.
-- Troca por permissão, com o MESMO conjunto de papéis de sistema (todas admin+: owner e admin), então nada muda para eles:
--   audit_logs               audit.view                     (atLeast admin)
--   intelligence_tool_calls  intelligence.scope_account     (atLeast admin)
--   ai_prompt_versions       ai.config                      (atLeast admin; é a permissão que a rota /api/ai/prompt-versions já exige)
--   account_invitations      members.invite                 (atLeast admin)
--   quick_replies (só o termo "admin" da visibilidade de equipe) inbox.quick_replies.manage (atLeast admin); o resto da policy (conta, pessoal, equipe) fica igual
-- account_invitations_modify (FOR ALL, admin) TAMBÉM concedia SELECT (uma policy ALL vale para leitura): é trocada por INSERT/UPDATE/DELETE com a MESMA condição
-- de hoje (admin+); assim a leitura passa a depender só da policy nova. As demais tabelas não têm policy ALL.
--
-- SEGURANÇA DA TROCA: has_perm é fail-closed (perfil sem role_id = false). Com QUALQUER perfil sem role_id a migration ABORTA sem alterar nada.
--
-- PRÉ-CHECK:  SELECT count(*) FROM wacrm.profiles WHERE role_id IS NULL;                                                              -- 0 (senão aborta)
--             SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname='wacrm' AND tablename IN ('audit_logs','intelligence_tool_calls','ai_prompt_versions','account_invitations','quick_replies') ORDER BY 1,2;
--             -- esperado: uma _select por tabela + account_invitations_modify (ALL) + as de escrita de quick_replies. Outra policy permissiva de leitura continuaria abrindo a leitura.
--             SELECT key FROM wacrm.permission_catalog WHERE key IN ('audit.view','intelligence.scope_account','ai.config','members.invite','inbox.quick_replies.manage');   -- 5 linhas
-- VERIFICAÇÃO: como admin (JWT), SELECT count(*) FROM wacrm.audit_logs → igual a antes; como operador → 0 (como antes).
-- ORDEM: antes ou depois do deploy (o app não depende dela). Idempotente.
-- ROLLBACK:   BEGIN;
--             DROP POLICY IF EXISTS audit_logs_select ON wacrm.audit_logs;
--             CREATE POLICY audit_logs_select ON wacrm.audit_logs FOR SELECT USING (wacrm.is_account_member(account_id) AND EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid() AND p.account_id = audit_logs.account_id AND p.account_role IN ('owner', 'admin')));
--             DROP POLICY IF EXISTS intelligence_tool_calls_select ON wacrm.intelligence_tool_calls;
--             CREATE POLICY intelligence_tool_calls_select ON wacrm.intelligence_tool_calls FOR SELECT TO authenticated USING (wacrm.is_account_member(account_id) AND EXISTS (SELECT 1 FROM wacrm.profiles p WHERE p.user_id = auth.uid() AND p.account_id = intelligence_tool_calls.account_id AND p.account_role IN ('owner', 'admin')));
--             DROP POLICY IF EXISTS ai_prompt_versions_select ON wacrm.ai_prompt_versions;
--             CREATE POLICY ai_prompt_versions_select ON wacrm.ai_prompt_versions FOR SELECT USING (wacrm.is_account_member(account_id, 'admin'));
--             DROP POLICY IF EXISTS account_invitations_select ON wacrm.account_invitations;
--             DROP POLICY IF EXISTS account_invitations_insert ON wacrm.account_invitations;
--             DROP POLICY IF EXISTS account_invitations_update ON wacrm.account_invitations;
--             DROP POLICY IF EXISTS account_invitations_delete ON wacrm.account_invitations;
--             DROP POLICY IF EXISTS account_invitations_modify ON wacrm.account_invitations;
--             CREATE POLICY account_invitations_select ON wacrm.account_invitations FOR SELECT USING (wacrm.is_account_member(account_id, 'admin'));
--             CREATE POLICY account_invitations_modify ON wacrm.account_invitations FOR ALL USING (wacrm.is_account_member(account_id, 'admin')) WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
--             DROP POLICY IF EXISTS quick_replies_select ON wacrm.quick_replies;
--             CREATE POLICY quick_replies_select ON wacrm.quick_replies FOR SELECT USING (wacrm.is_account_member(account_id) AND (visibility = 'account' OR (visibility = 'personal' AND created_by = auth.uid()) OR (visibility = 'team' AND (wacrm.is_account_member(account_id, 'admin') OR team_id IN (SELECT tm.team_id FROM wacrm.team_members tm WHERE tm.user_id = auth.uid())))));
--             DELETE FROM wacrm.schema_migrations WHERE version = '325_audit_admin_tables_rls_has_perm';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_orphans integer;
  t text;
BEGIN
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '325: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  IF (SELECT count(*) FROM wacrm.permission_catalog WHERE key IN ('audit.view', 'intelligence.scope_account', 'ai.config', 'members.invite', 'inbox.quick_replies.manage')) <> 5 THEN
    RAISE EXCEPTION '325: faltam chaves no catálogo (audit.view, intelligence.scope_account, ai.config, members.invite, inbox.quick_replies.manage — migration 240)';
  END IF;
  FOREACH t IN ARRAY ARRAY['audit_logs', 'intelligence_tool_calls', 'ai_prompt_versions', 'account_invitations', 'quick_replies', 'team_members'] LOOP
    IF to_regclass('wacrm.' || t) IS NULL THEN
      RAISE EXCEPTION '325: falta wacrm.% — confira o schema vivo', t;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_orphans FROM wacrm.profiles WHERE role_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '325: % perfil(is) sem role_id perderiam estas leituras (has_perm é fail-closed) — preencha o role_id antes. Nada foi alterado.', v_orphans;
  END IF;
END $$;

DROP POLICY IF EXISTS audit_logs_select ON wacrm.audit_logs;
CREATE POLICY audit_logs_select ON wacrm.audit_logs FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('audit.view'))
);

DROP POLICY IF EXISTS intelligence_tool_calls_select ON wacrm.intelligence_tool_calls;
CREATE POLICY intelligence_tool_calls_select ON wacrm.intelligence_tool_calls FOR SELECT TO authenticated USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('intelligence.scope_account'))
);

DROP POLICY IF EXISTS ai_prompt_versions_select ON wacrm.ai_prompt_versions;
CREATE POLICY ai_prompt_versions_select ON wacrm.ai_prompt_versions FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('ai.config'))
);

-- convites: a policy FOR ALL (modify) também lia; separa em escrita (mesma condição de hoje) e leitura por permissão
DROP POLICY IF EXISTS account_invitations_select ON wacrm.account_invitations;
DROP POLICY IF EXISTS account_invitations_modify ON wacrm.account_invitations;
DROP POLICY IF EXISTS account_invitations_insert ON wacrm.account_invitations;
DROP POLICY IF EXISTS account_invitations_update ON wacrm.account_invitations;
DROP POLICY IF EXISTS account_invitations_delete ON wacrm.account_invitations;
CREATE POLICY account_invitations_select ON wacrm.account_invitations FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('members.invite'))
);
CREATE POLICY account_invitations_insert ON wacrm.account_invitations FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
CREATE POLICY account_invitations_update ON wacrm.account_invitations FOR UPDATE USING (wacrm.is_account_member(account_id, 'admin')) WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
CREATE POLICY account_invitations_delete ON wacrm.account_invitations FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS quick_replies_select ON wacrm.quick_replies;
CREATE POLICY quick_replies_select ON wacrm.quick_replies FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (
    visibility = 'account'
    OR (visibility = 'personal' AND created_by = auth.uid())
    OR (visibility = 'team' AND (
          (SELECT wacrm.has_perm('inbox.quick_replies.manage'))
          OR team_id IN (SELECT tm.team_id FROM wacrm.team_members tm WHERE tm.user_id = auth.uid())))
  )
);

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('325_audit_admin_tables_rls_has_perm') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
