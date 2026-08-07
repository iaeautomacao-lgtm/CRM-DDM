-- ============================================================
-- 049_teams.sql — Teams foundation (schema only)
--
-- Phase 3a of "Equipes" in the Monitoramento roadmap: schema, manual
-- CRUD, and display only. NO automatic assignment (phase 3b, via the
-- Automations engine) and NO overflow/session-timeout automation
-- (phase 3c) yet — session_timeout_minutes and overflow_team_id are
-- configurable here but nothing reads them until those later phases.
--
-- Design
--   - One agent belongs to at most one team: profiles.team_id, a
--     plain column, not a join table (locked decision).
--   - teams.account_id is direct (NOT via a parent join) — same
--     pattern as tags/custom_fields, migration 017's
--     "settings-class" tables, which teams joins.
--   - conversations.team_id is added now (schema only) — nothing
--     writes it yet. Phase 3b's automation action will.
--
-- Why set_member_team exists (not just the column)
--   profiles_update RLS (017) is `auth.uid() = user_id` only — an
--   admin cannot UPDATE a teammate's row directly, by design (see
--   018_account_member_rpcs.sql's header comment: role changes go
--   through set_member_role for the same reason). Assigning a
--   teammate to a team is the identical kind of write, so it needs
--   the identical SECURITY DEFINER escape hatch, scoped the same way
--   (caller must be admin+, target must be in caller's account).
--
-- Table/FK/index DDL below is explicitly wacrm.-qualified. That's
-- NOT enough on its own, though: a `CREATE POLICY ... USING (expr)`
-- resolves unqualified function calls inside `expr` (is_account_member
-- below) using the SESSION's search_path at the moment the policy is
-- created — a policy has no equivalent of a function's own `SET
-- search_path`, so it can't carry that with it the way
-- set_member_team does. Pasting this file standalone (session
-- search_path defaults to just `public`) previously made
-- `is_account_member` fail to resolve — `wacrm.is_account_member(...)`
-- would also fix it, but the line below matches the exact convention
-- every other migration relies on (see all_migrations.sql:2) instead
-- of qualifying every call site individually.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

SET search_path TO wacrm, public, extensions;

-- ---- table -----------------------------------------------------
CREATE TABLE IF NOT EXISTS wacrm.teams (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Configurable now, read by nobody until phase 3c implements the
  -- session-timeout/overflow check.
  session_timeout_minutes INTEGER,
  -- The team conversations overflow INTO once phase 3c implements
  -- that behaviour. A team can't be its own overflow target.
  overflow_team_id UUID REFERENCES wacrm.teams(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT teams_overflow_not_self
    CHECK (overflow_team_id IS NULL OR overflow_team_id <> id),
  CONSTRAINT teams_session_timeout_positive
    CHECK (session_timeout_minutes IS NULL OR session_timeout_minutes > 0)
);

CREATE INDEX IF NOT EXISTS idx_teams_account ON wacrm.teams(account_id);

ALTER TABLE wacrm.teams ENABLE ROW LEVEL SECURITY;

-- Same split as tags (017_account_sharing.sql:392-396): any account
-- member reads (the Monitoramento "Equipes" tab needs every agent to
-- see the team roster, not just admins); admin+ writes.
DROP POLICY IF EXISTS teams_select ON wacrm.teams;
DROP POLICY IF EXISTS teams_insert ON wacrm.teams;
DROP POLICY IF EXISTS teams_update ON wacrm.teams;
DROP POLICY IF EXISTS teams_delete ON wacrm.teams;
CREATE POLICY teams_select ON wacrm.teams FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY teams_insert ON wacrm.teams FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY teams_update ON wacrm.teams FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY teams_delete ON wacrm.teams FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON wacrm.teams;
-- Unqualified deliberately — update_updated_at_column() has never
-- been re-qualified with wacrm. anywhere in the migration history
-- (unlike touch_presence/redeem_invitation/seed_tabulacao_tags), so
-- every existing trigger calls it bare and relies on search_path
-- fallback to find it wherever it actually lives. Matching that here.
CREATE TRIGGER set_updated_at BEFORE UPDATE ON wacrm.teams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---- profiles.team_id --------------------------------------------
ALTER TABLE wacrm.profiles
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES wacrm.teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_team ON wacrm.profiles(team_id);

-- ---- conversations.team_id -----------------------------------------
-- Schema only in this phase — nothing writes this column yet. Phase
-- 3b's Automations action sets it on assignment; phase 3c's overflow
-- logic moves it to another team's id.
ALTER TABLE wacrm.conversations
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES wacrm.teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_team ON wacrm.conversations(team_id);

-- ============================================================
-- set_member_team(p_user_id, p_team_id)
--
-- Admin+ moves another member of the caller's account into a team
-- (p_team_id NULL removes them from their current team). Mirrors
-- set_member_role's shape (018_account_member_rpcs.sql) exactly —
-- same authority checks, same SQLSTATE contract — for the identical
-- reason: profiles_update RLS only allows self-updates.
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.set_member_team(
  p_user_id UUID,
  p_team_id UUID
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

  IF p_team_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM teams WHERE id = p_team_id AND account_id = v_caller_account_id
  ) THEN
    RAISE EXCEPTION 'Team not found in your account' USING ERRCODE = '22023';
  END IF;

  UPDATE profiles SET team_id = p_team_id WHERE user_id = p_user_id;
END;
$$;

ALTER FUNCTION wacrm.set_member_team(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.set_member_team(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.set_member_team(UUID, UUID) TO authenticated;
