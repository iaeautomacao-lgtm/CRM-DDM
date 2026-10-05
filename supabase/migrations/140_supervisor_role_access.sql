-- Migration 140: regras de acesso do papel "supervisor" (PRD-04).
-- APLICAR MANUALMENTE no Supabase SQL Editor DEPOIS da 139 (já commitada).
-- Conferir o schema live antes (CLAUDE.md) — em especial as policies
-- conversations_select (128) e whatsapp_config_select (103), que esta
-- migration substitui.
--
-- Hierarquia (igual a src/lib/auth/roles.ts):
--   owner 5 · admin 4 · supervisor 3 · agent 2 · viewer 1
-- Sem esta migration, is_account_member() não conhece 'supervisor' (o
-- CASE devolve NULL) e o supervisor perderia acesso a tudo.
--
-- O supervisor:
--   - pode tudo que o agente pode (ranking ≥ agent);
--   - NÃO pode o que exige admin (configurações, membros, canais…);
--   - enxerga as conversas das equipes de que participa (team_members),
--     atribuídas ou não, as atribuídas a ele e as SEM equipe atribuídas a
--     membros dessas equipes — Inbox e Monitoramento leem com a sessão do
--     usuário e ficam escopados por esta regra; o Intelligence escopa no
--     servidor pelas mesmas equipes;
--   - NÃO acessa Relatórios nesta fase: as RPCs de relatório são
--     SECURITY DEFINER e devolveriam a conta inteira;
--   - enxerga as linhas (whatsapp_config) das suas equipes e as sem
--     equipe, como o agente.

BEGIN;

-- ---- ranking de papéis (mantém nome, assinatura, dono e grants) -------
-- Atualiza TODAS as cópias de is_account_member(uuid, account_role_enum)
-- (017 criou sem schema; 103+ chamam wacrm.is_account_member): uma cópia
-- esquecida com o CASE antigo devolveria NULL para o supervisor.
DO $$
DECLARE
  v_schema text;
  v_enum_schema text;
  v_count int := 0;
BEGIN
  SELECT n.nspname INTO v_enum_schema
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE t.typname = 'account_role_enum';
  IF v_enum_schema IS NULL THEN
    RAISE EXCEPTION 'account_role_enum não encontrado';
  END IF;

  FOR v_schema IN
    SELECT n.nspname
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'is_account_member' AND p.pronargs = 2
  LOOP
  v_count := v_count + 1;
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION %1$I.is_account_member(
      target_account_id UUID,
      min_role %2$I.account_role_enum DEFAULT 'viewer'
    ) RETURNS BOOLEAN
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = ''
    AS $body$
      SELECT EXISTS (
        SELECT 1
        FROM wacrm.profiles p
        WHERE p.user_id = auth.uid()
          AND p.account_id = target_account_id
          AND CASE p.account_role::text
                WHEN 'owner'      THEN 5
                WHEN 'admin'      THEN 4
                WHEN 'supervisor' THEN 3
                WHEN 'agent'      THEN 2
                WHEN 'viewer'     THEN 1
              END
            >=
              CASE min_role::text
                WHEN 'owner'      THEN 5
                WHEN 'admin'      THEN 4
                WHEN 'supervisor' THEN 3
                WHEN 'agent'      THEN 2
                WHEN 'viewer'     THEN 1
              END
      );
    $body$
  $f$, v_schema, v_enum_schema);
  END LOOP;

  IF v_count = 0 THEN
    RAISE EXCEPTION 'is_account_member(uuid, account_role_enum) não encontrada';
  END IF;
  IF to_regprocedure(format('wacrm.is_account_member(uuid, %I.account_role_enum)', v_enum_schema)) IS NULL THEN
    RAISE EXCEPTION 'wacrm.is_account_member não existe — as policies abaixo dependem dela';
  END IF;
END;
$$;

-- Equipes do usuário atual (evita repetir o subselect nas policies).
CREATE OR REPLACE FUNCTION wacrm.current_user_team_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public
AS $$
  SELECT tm.team_id FROM wacrm.team_members tm WHERE tm.user_id = auth.uid()
$$;
REVOKE ALL ON FUNCTION wacrm.current_user_team_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.current_user_team_ids() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION wacrm.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public
AS $$
  SELECT p.account_role::text FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1
$$;
REVOKE ALL ON FUNCTION wacrm.current_user_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.current_user_role() TO authenticated, service_role;

-- ---- conversas: agente (128) + supervisor por equipe ------------------
-- Funções em (SELECT …): o Postgres calcula uma vez por consulta (initPlan)
-- em vez de uma vez por linha.
DROP POLICY IF EXISTS conversations_select ON wacrm.conversations;
CREATE POLICY conversations_select ON wacrm.conversations FOR SELECT USING (
  wacrm.is_account_member(account_id)
  AND (
    -- owner/admin/viewer: conta toda (inalterado)
    coalesce((SELECT wacrm.current_user_role()), '') NOT IN ('agent', 'supervisor')
    -- agente: as dele + fila sem atendente da(s) equipe(s) (128)
    OR (
      (SELECT wacrm.current_user_role()) = 'agent'
      AND (
        assigned_agent_id = (SELECT auth.uid())
        OR (
          assigned_agent_id IS NULL
          AND status IN ('open', 'pending')
          AND team_id IN (SELECT wacrm.current_user_team_ids())
        )
      )
    )
    -- supervisor: tudo das suas equipes + o que está com ele + as SEM
    -- equipe atribuídas a membros delas. Conversa de OUTRA equipe com um
    -- membro em comum não entra (o membro pode estar em várias equipes).
    OR (
      (SELECT wacrm.current_user_role()) = 'supervisor'
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
  )
);

-- ---- linhas: supervisor como o agente (103) ---------------------------
DROP POLICY IF EXISTS whatsapp_config_select ON wacrm.whatsapp_config;
CREATE POLICY whatsapp_config_select ON wacrm.whatsapp_config FOR SELECT USING (
  wacrm.is_account_member(account_id)
  AND (
    coalesce((SELECT wacrm.current_user_role()), '') NOT IN ('agent', 'supervisor')
    OR team_id IN (SELECT wacrm.current_user_team_ids())
    OR team_id IS NULL
  )
);

NOTIFY pgrst, 'reload schema';
COMMIT;
