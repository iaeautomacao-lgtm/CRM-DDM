-- ============================================================
-- 311_member_deactivation_last_access.sql   (TASK3 — Usuários: último acesso e desativar/reativar membro)
--
-- O QUE FAZ:
--   1. wacrm.profiles ganha deactivated_at / deactivated_by (NULL = ativo). O próprio usuário NÃO consegue mexer: a 169 só
--      concede UPDATE de (full_name, avatar_url) ao authenticated — estas colunas ficam fora (o teste confere).
--   2. wacrm.set_member_active(conta, ator, alvo, ativo): desativa ou reativa um membro da MESMA conta. Recusa o proprietário
--      e o próprio ator (42501). Ao desativar: marca o perfil, apaga TODAS as sessões do alvo em auth.sessions (os refresh
--      tokens caem em cascata) e tira a presença (member_presence) para ele sair da distribuição na hora. Devolve o estado
--      anterior (para a auditoria e para idempotência). SECURITY DEFINER, só service_role (a rota checa members.manage).
--   3. wacrm.account_members_access(conta): último login (auth.users.last_sign_in_at) e última atividade (maior
--      refreshed_at/updated_at das sessões) de cada membro da conta. SECURITY DEFINER, só service_role. Nunca devolve
--      e-mail, IP nem token.
--   O bloqueio no app (getCurrentAccount → 403 member_deactivated) e o banimento no Supabase Auth (sem login nem renovação)
--   ficam na rota/servidor; a distribuição de conversas ignora perfis desativados.
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.profiles'), to_regclass('auth.users'), to_regclass('auth.sessions'), to_regclass('wacrm.member_presence');
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'profiles'
--      AND column_name IN ('deactivated_at', 'deactivated_by');                          -- 0 linhas na 1ª vez
--   SELECT privilege_type, column_name FROM information_schema.column_privileges
--    WHERE table_schema = 'wacrm' AND table_name = 'profiles' AND grantee = 'authenticated' AND privilege_type = 'UPDATE';
--      -- esperado: só full_name e avatar_url (migration 169)
-- VERIFICAÇÃO:
--   SELECT * FROM wacrm.account_members_access('<account_id>');                          -- (service role / SQL Editor)
--   SELECT version FROM wacrm.schema_migrations WHERE version = '311_member_deactivation_last_access';
-- ORDEM: ANTES do deploy (a rota de membros, o getCurrentAccount e a distribuição passam a ler deactivated_at). Idempotente.
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS wacrm.set_member_active(uuid, uuid, uuid, boolean);
--   DROP FUNCTION IF EXISTS wacrm.account_members_access(uuid);
--   ALTER TABLE wacrm.profiles DROP COLUMN IF EXISTS deactivated_at, DROP COLUMN IF EXISTS deactivated_by;
--   (antes do DROP COLUMN: reverter o deploy, senão o app lê colunas que não existem)
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.profiles') IS NULL OR to_regclass('auth.users') IS NULL OR to_regclass('auth.sessions') IS NULL THEN
    RAISE EXCEPTION '311: faltam wacrm.profiles / auth.users / auth.sessions — confira o schema vivo';
  END IF;
  IF to_regclass('wacrm.member_presence') IS NULL THEN
    RAISE EXCEPTION '311: falta wacrm.member_presence (migration 024)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.column_privileges
     WHERE table_schema = 'wacrm' AND table_name = 'profiles' AND grantee = 'authenticated'
       AND privilege_type = 'UPDATE' AND column_name IN ('deactivated_at', 'deactivated_by')
  ) THEN
    RAISE EXCEPTION '311: authenticated tem UPDATE em deactivated_at/by — o usuário poderia se reativar; revise os grants de profiles';
  END IF;
END $$;

ALTER TABLE wacrm.profiles
  ADD COLUMN IF NOT EXISTS deactivated_at timestamptz,
  ADD COLUMN IF NOT EXISTS deactivated_by uuid;

-- Grant de tabela inteira (anterior à 169) daria UPDATE nas colunas novas: garante que não há.
REVOKE UPDATE (deactivated_at, deactivated_by) ON wacrm.profiles FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION wacrm.set_member_active(p_account uuid, p_actor uuid, p_target uuid, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_role text;
  v_prev timestamptz;
  v_sessions integer := 0;
BEGIN
  IF p_account IS NULL OR p_actor IS NULL OR p_target IS NULL OR p_active IS NULL THEN
    RAISE EXCEPTION 'Argumentos inválidos' USING ERRCODE = '22023';
  END IF;
  IF p_actor = p_target THEN
    RAISE EXCEPTION 'Você não pode desativar ou reativar a si mesmo' USING ERRCODE = '42501';
  END IF;

  SELECT account_role::text, deactivated_at INTO v_role, v_prev
    FROM wacrm.profiles
   WHERE user_id = p_target AND account_id = p_account
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Membro não encontrado nesta organização' USING ERRCODE = 'P0002';
  END IF;
  IF v_role = 'owner' THEN
    RAISE EXCEPTION 'O proprietário não pode ser desativado' USING ERRCODE = '42501';
  END IF;

  IF p_active THEN
    UPDATE wacrm.profiles SET deactivated_at = NULL, deactivated_by = NULL WHERE user_id = p_target AND account_id = p_account;
  ELSE
    UPDATE wacrm.profiles
       SET deactivated_at = coalesce(deactivated_at, now()), deactivated_by = coalesce(deactivated_by, p_actor)
     WHERE user_id = p_target AND account_id = p_account;
    DELETE FROM auth.sessions WHERE user_id = p_target;
    GET DIAGNOSTICS v_sessions = ROW_COUNT;
    DELETE FROM wacrm.member_presence WHERE user_id = p_target;
  END IF;

  RETURN jsonb_build_object(
    'was_active', v_prev IS NULL,
    'is_active', p_active,
    'role', v_role,
    'sessions_revoked', v_sessions
  );
END $$;
REVOKE ALL ON FUNCTION wacrm.set_member_active(uuid, uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.set_member_active(uuid, uuid, uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION wacrm.account_members_access(p_account uuid)
RETURNS TABLE (user_id uuid, last_sign_in_at timestamptz, last_active_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT p.user_id,
         u.last_sign_in_at,
         -- refreshed_at é timestamp SEM fuso no GoTrue (UTC): converter como UTC, não pelo fuso da sessão.
    (SELECT max(coalesce(((to_jsonb(s) ->> 'refreshed_at')::timestamp AT TIME ZONE 'UTC'), s.updated_at, s.created_at))
            FROM auth.sessions s
           WHERE s.user_id = p.user_id) AS last_active_at
    FROM wacrm.profiles p
    LEFT JOIN auth.users u ON u.id = p.user_id
   WHERE p.account_id = p_account
$$;
REVOKE ALL ON FUNCTION wacrm.account_members_access(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.account_members_access(uuid) TO service_role;

-- Registro (202): tolera banco sem a 202 ainda; idempotente.
DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('311_member_deactivation_last_access') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
