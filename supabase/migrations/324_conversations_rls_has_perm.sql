-- ============================================================
-- 324_conversations_rls_has_perm.sql   (RLS fase 2, lote L2 — conversas e linhas (whatsapp_config) pelo catálogo; equivalência EXATA nos papéis de sistema)
--
-- Hoje conversations_select e whatsapp_config_select (migration 140) decidem pelo NOME do papel (`current_user_role()`): owner/admin/viewer veem a
-- conta toda; operador vê as dele + a fila da equipe; supervisor vê as das equipes dele. Um papel personalizado herdava o `compat_role` (o menor papel
-- de sistema que contém todas as permissões dele) e podia ver MAIS do que as permissões dele dizem. Aqui a regra passa a ser por PERMISSÃO:
--   conversations.scope_all   (owner, admin, viewer)  → todas as conversas da conta
--   conversations.scope_team  (supervisor)             → as das equipes dele (mesma regra de hoje do supervisor)
--   inbox.view                (agent, supervisor, admin, owner) → as dele + a fila sem atendente da(s) equipe(s) dele (mesma regra de hoje do operador)
-- Equivalência para os papéis de sistema, por construção:
--   owner/admin/viewer: têm scope_all ⇒ tudo (hoje: papel fora de agent/supervisor ⇒ tudo).
--   operador: só inbox.view ⇒ a cláusula do operador (igual a hoje).
--   supervisor: scope_team ⇒ cláusula do supervisor; ele também tem inbox.view, mas a cláusula do operador é SUBCONJUNTO da dele (atribuída a ele ⊂
--   "atribuída a ele"; sem atendente aberta/pendente da equipe ⊂ "da equipe"), então não amplia (provado no teste PGlite).
-- whatsapp_config: "NOT IN (agent, supervisor)" = owner/admin/viewer = exatamente quem tem conversations.scope_all (usada como chave de escopo; criar
-- `channels.view_all` só renomearia a mesma regra) + channels.view (de todos os papéis de sistema). Equipe dele e linhas sem equipe seguem iguais.
--
-- SEGURANÇA DA TROCA: has_perm é fail-closed (perfil sem role_id = false ⇒ sem conversa nenhuma). Se houver QUALQUER perfil sem role_id a migration
-- ABORTA sem alterar nada. As funções de papel entram como (SELECT …): uma avaliação por consulta (e por evento do Realtime), como na 140.
--
-- PRÉ-CHECK:  SELECT count(*) FROM wacrm.profiles WHERE role_id IS NULL;                                                   -- 0 (senão aborta)
--             SELECT policyname FROM pg_policies WHERE schemaname='wacrm' AND tablename IN ('conversations','whatsapp_config') AND cmd IN ('SELECT','ALL');
--             -- esperado: conversations_select e whatsapp_config_select (140). Se houver OUTRA policy permissiva de leitura, ela continua abrindo a leitura.
--             SELECT key FROM wacrm.permission_catalog WHERE key IN ('conversations.scope_all','conversations.scope_team','inbox.view','channels.view'); -- 4 linhas
-- VERIFICAÇÃO: como operador (JWT), SELECT count(*) FROM wacrm.conversations → igual a antes da migration; Inbox e contador de não lidas (Realtime) normais.
-- ORDEM: antes ou depois do deploy. Idempotente.
-- ROLLBACK:   BEGIN;
--             DROP POLICY IF EXISTS conversations_select ON wacrm.conversations;
--             CREATE POLICY conversations_select ON wacrm.conversations FOR SELECT USING (wacrm.is_account_member(account_id) AND (coalesce((SELECT wacrm.current_user_role()), '') NOT IN ('agent', 'supervisor') OR ((SELECT wacrm.current_user_role()) = 'agent' AND (assigned_agent_id = (SELECT auth.uid()) OR (assigned_agent_id IS NULL AND status IN ('open', 'pending') AND team_id IN (SELECT wacrm.current_user_team_ids())))) OR ((SELECT wacrm.current_user_role()) = 'supervisor' AND (team_id IN (SELECT wacrm.current_user_team_ids()) OR assigned_agent_id = (SELECT auth.uid()) OR (team_id IS NULL AND assigned_agent_id IN (SELECT tm.user_id FROM wacrm.team_members tm WHERE tm.team_id IN (SELECT wacrm.current_user_team_ids())))))));
--             DROP POLICY IF EXISTS whatsapp_config_select ON wacrm.whatsapp_config;
--             CREATE POLICY whatsapp_config_select ON wacrm.whatsapp_config FOR SELECT USING (wacrm.is_account_member(account_id) AND (coalesce((SELECT wacrm.current_user_role()), '') NOT IN ('agent', 'supervisor') OR team_id IN (SELECT wacrm.current_user_team_ids()) OR team_id IS NULL));
--             DELETE FROM wacrm.schema_migrations WHERE version = '324_conversations_rls_has_perm';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_orphans integer;
BEGIN
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '324: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  IF (SELECT count(*) FROM wacrm.permission_catalog WHERE key IN ('conversations.scope_all', 'conversations.scope_team', 'inbox.view', 'channels.view')) <> 4 THEN
    RAISE EXCEPTION '324: faltam chaves no catálogo (conversations.scope_all/scope_team, inbox.view, channels.view — migration 240)';
  END IF;
  IF to_regprocedure('wacrm.current_user_team_ids()') IS NULL THEN
    RAISE EXCEPTION '324: falta wacrm.current_user_team_ids() (migration 140)';
  END IF;
  IF to_regclass('wacrm.conversations') IS NULL OR to_regclass('wacrm.whatsapp_config') IS NULL OR to_regclass('wacrm.team_members') IS NULL THEN
    RAISE EXCEPTION '324: faltam wacrm.conversations/whatsapp_config/team_members — confira o schema vivo';
  END IF;
  SELECT count(*) INTO v_orphans FROM wacrm.profiles WHERE role_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '324: % perfil(is) sem role_id perderiam todas as conversas (has_perm é fail-closed) — preencha o role_id antes. Nada foi alterado.', v_orphans;
  END IF;
END $$;

DROP POLICY IF EXISTS conversations_select ON wacrm.conversations;
CREATE POLICY conversations_select ON wacrm.conversations FOR SELECT USING (
  wacrm.is_account_member(account_id)
  AND (
    -- owner/admin/viewer: conta toda
    (SELECT wacrm.has_perm('conversations.scope_all'))
    -- supervisor: tudo das suas equipes + o que está com ele + as SEM equipe atribuídas a membros delas
    OR (
      (SELECT wacrm.has_perm('conversations.scope_team'))
      AND (
        team_id IN (SELECT wacrm.current_user_team_ids())
        OR assigned_agent_id = (SELECT auth.uid())
        OR (
          team_id IS NULL
          AND assigned_agent_id IN (
            SELECT tm.user_id FROM wacrm.team_members tm
            WHERE tm.team_id IN (SELECT wacrm.current_user_team_ids())
          )
        )
      )
    )
    -- operador: as dele + fila sem atendente da(s) equipe(s) dele
    OR (
      (SELECT wacrm.has_perm('inbox.view'))
      AND (
        assigned_agent_id = (SELECT auth.uid())
        OR (
          assigned_agent_id IS NULL
          AND status IN ('open', 'pending')
          AND team_id IN (SELECT wacrm.current_user_team_ids())
        )
      )
    )
  )
);

DROP POLICY IF EXISTS whatsapp_config_select ON wacrm.whatsapp_config;
CREATE POLICY whatsapp_config_select ON wacrm.whatsapp_config FOR SELECT USING (
  wacrm.is_account_member(account_id)
  AND (SELECT wacrm.has_perm('channels.view'))
  AND (
    (SELECT wacrm.has_perm('conversations.scope_all'))
    OR team_id IN (SELECT wacrm.current_user_team_ids())
    OR team_id IS NULL
  )
);

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('324_conversations_rls_has_perm') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
