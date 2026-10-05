-- Migration 135: regras de acesso do papel "supervisor" (PRD-04).
-- APLICAR MANUALMENTE no Supabase SQL Editor DEPOIS da 134 (já commitada).
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
--     atribuídas ou não, mais as atribuídas a ele ou a membros dessas
--     equipes — Inbox, Monitoramento, Relatórios e Intelligence leem
--     com a sessão do usuário e ficam escopados por esta regra;
--   - enxerga as linhas (whatsapp_config) das suas equipes e as sem
--     equipe, como o agente.

BEGIN;

-- ---- ranking de papéis (mantém nome, assinatura, dono e grants) -------
DO $$
DECLARE
  v_schema text;
  v_enum_schema text;
BEGIN
  SELECT n.nspname INTO v_schema
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'is_account_member' AND p.pronargs = 2
  LIMIT 1;
  SELECT n.nspname INTO v_enum_schema
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE t.typname = 'account_role_enum'
  LIMIT 1;
  IF v_schema IS NULL OR v_enum_schema IS NULL THEN
    RAISE EXCEPTION 'is_account_member/account_role_enum não encontrados';
  END IF;

  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION %1$I.is_account_member(
      target_account_id UUID,
      min_role %2$I.account_role_enum DEFAULT 'viewer'
    ) RETURNS BOOLEAN
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = %1$I, wacrm, public
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
DROP POLICY IF EXISTS conversations_select ON wacrm.conversations;
CREATE POLICY conversations_select ON wacrm.conversations FOR SELECT USING (
  is_account_member(account_id)
  AND (
    -- owner/admin/viewer: conta toda (inalterado)
    coalesce(wacrm.current_user_role(), '') NOT IN ('agent', 'supervisor')
    -- agente: as dele + fila sem atendente da(s) equipe(s) (128)
    OR (
      wacrm.current_user_role() = 'agent'
      AND (
        assigned_agent_id = auth.uid()
        OR (
          assigned_agent_id IS NULL
          AND status IN ('open', 'pending')
          AND team_id IN (SELECT wacrm.current_user_team_ids())
        )
      )
    )
    -- supervisor: tudo das suas equipes + o que está com ele ou com
    -- membros delas (conversa sem equipe atribuída a alguém da equipe)
    OR (
      wacrm.current_user_role() = 'supervisor'
      AND (
        team_id IN (SELECT wacrm.current_user_team_ids())
        OR assigned_agent_id = auth.uid()
        OR assigned_agent_id IN (
          SELECT tm.user_id FROM wacrm.team_members tm
          WHERE tm.team_id IN (SELECT wacrm.current_user_team_ids())
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
    coalesce(wacrm.current_user_role(), '') NOT IN ('agent', 'supervisor')
    OR team_id IN (SELECT wacrm.current_user_team_ids())
    OR team_id IS NULL
  )
);

NOTIFY pgrst, 'reload schema';
COMMIT;
