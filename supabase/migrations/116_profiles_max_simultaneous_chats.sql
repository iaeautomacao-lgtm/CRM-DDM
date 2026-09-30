-- Migration 116: wacrm.profiles.max_simultaneous_chats — teto de
-- atendimentos simultâneos por agente, usado por selectAgentForTeam/
-- selectAnyAgentForAccount (src/lib/flows/engine.ts) na distribuição
-- automática de handoff_team. NULL = sem limite (comportamento atual,
-- zero breaking changes).
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

ALTER TABLE wacrm.profiles
  ADD COLUMN IF NOT EXISTS max_simultaneous_chats INTEGER DEFAULT NULL;

ALTER TABLE wacrm.profiles
  ADD CONSTRAINT profiles_max_simultaneous_chats_positive
    CHECK (max_simultaneous_chats IS NULL OR max_simultaneous_chats >= 1);

COMMENT ON COLUMN wacrm.profiles.max_simultaneous_chats IS
  'Limite de atendimentos simultâneos do agente. NULL = sem limite.';

-- ============================================================
-- set_member_max_simultaneous_chats(p_user_id, p_max)
--
-- Admin+ define o teto de outro membro do próprio account. Mesmo
-- motivo de existir de set_member_role (018_account_member_rpcs.sql)
-- e set_member_team (049_teams.sql): a policy profiles_update (017)
-- só permite auth.uid() = user_id, então um admin não consegue dar
-- UPDATE direto na linha de um colega — precisa do mesmo escape hatch
-- SECURITY DEFINER, com as mesmas checagens de autoridade e o mesmo
-- contrato de SQLSTATE (42501 -> 403, 22023 -> 400) que
-- rpcErrorToResponse (em /api/account/members/[userId]/route.ts) já
-- trata para as outras duas RPCs.
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.set_member_max_simultaneous_chats(
  p_user_id UUID,
  p_max INTEGER
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  SELECT account_id INTO v_target_account_id
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF p_max IS NOT NULL AND p_max < 1 THEN
    RAISE EXCEPTION 'max_simultaneous_chats must be a positive integer or null'
      USING ERRCODE = '22023';
  END IF;

  UPDATE profiles SET max_simultaneous_chats = p_max WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION wacrm.set_member_max_simultaneous_chats(UUID, INTEGER) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.set_member_max_simultaneous_chats(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.set_member_max_simultaneous_chats(UUID, INTEGER) TO authenticated;
