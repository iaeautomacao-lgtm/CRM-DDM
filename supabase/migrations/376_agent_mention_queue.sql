-- 376_agent_mention_queue.sql
-- Renumbered: V2 already has 332_dispatch_provider_call_marker.sql.
-- Additive RLS policies: compatible with V1 140 and V2 324/347 revisions.
-- V1: @alias typed by the customer routes to that operator's WAITING queue.
-- PRE-CHECK (read-only, run before applying):
-- SELECT to_regclass('wacrm.profiles') IS NOT NULL AS profiles_ok,
--        to_regclass('wacrm.conversations') IS NOT NULL AS conversations_ok,
--        to_regclass('wacrm.flow_runs') IS NOT NULL AS runs_ok,
--        to_regclass('wacrm.team_members') IS NOT NULL AS team_members_ok;
-- This migration must run BEFORE deploying the corresponding application code.
-- No existing aliases are backfilled: administrators configure unique aliases.

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.profiles') IS NULL
     OR to_regclass('wacrm.conversations') IS NULL
     OR to_regclass('wacrm.flow_runs') IS NULL
     OR to_regclass('wacrm.teams') IS NULL
     OR to_regclass('wacrm.team_members') IS NULL THEN
    RAISE EXCEPTION '376: required CRM tables are missing';
  END IF;
  IF to_regprocedure('wacrm.current_user_role()') IS NULL
     OR to_regprocedure('wacrm.is_account_member(uuid,wacrm.account_role_enum)') IS NULL THEN
    RAISE EXCEPTION '376: required account authorization functions are missing';
  END IF;
END $$;

ALTER TABLE wacrm.profiles
  ADD COLUMN IF NOT EXISTS mention_alias text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'wacrm.profiles'::regclass
      AND conname = 'profiles_mention_alias_format'
  ) THEN
    ALTER TABLE wacrm.profiles
      ADD CONSTRAINT profiles_mention_alias_format
      CHECK (mention_alias IS NULL OR mention_alias ~ '^[a-z_][a-z0-9_]{1,31}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_account_mention_alias_unique
  ON wacrm.profiles (account_id, mention_alias)
  WHERE mention_alias IS NOT NULL;

-- Aliases belong to the server-managed admin API, not browser-side UPDATE.
CREATE OR REPLACE FUNCTION wacrm.guard_mention_alias_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' AND NEW.mention_alias IS NOT NULL THEN
      RAISE EXCEPTION 'mention aliases are administrator-managed' USING ERRCODE = '42501';
    ELSIF TG_OP = 'UPDATE' AND NEW.mention_alias IS DISTINCT FROM OLD.mention_alias THEN
      RAISE EXCEPTION 'mention aliases are administrator-managed' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_mention_alias ON wacrm.profiles;
CREATE TRIGGER trg_guard_mention_alias
  BEFORE INSERT OR UPDATE OF mention_alias ON wacrm.profiles
  FOR EACH ROW EXECUTE FUNCTION wacrm.guard_mention_alias_write();

ALTER TABLE wacrm.conversations
  ADD COLUMN IF NOT EXISTS requested_agent_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS conversations_requested_agent_pending_idx
  ON wacrm.conversations (account_id, requested_agent_id, last_message_at DESC)
  WHERE requested_agent_id IS NOT NULL AND assigned_agent_id IS NULL
    AND status IN ('open', 'pending');

-- Existing conversations_select (migration 140) permits agents to read the
-- unassigned queue of their team. A targeted item must ONLY be visible to
-- its intended agent (and account-scoped supervisors/admins).
-- A permissive policy allows the target, including when they have no team.
DROP POLICY IF EXISTS mention_queue_target_select ON wacrm.conversations;
CREATE POLICY mention_queue_target_select ON wacrm.conversations
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (
    wacrm.is_account_member(account_id, 'agent'::wacrm.account_role_enum)
    AND requested_agent_id = (SELECT auth.uid())
  );

-- This restrictive policy prevents other agents on the same team from
-- reading a conversation reserved for someone else.
DROP POLICY IF EXISTS mention_queue_private_select ON wacrm.conversations;
CREATE POLICY mention_queue_private_select ON wacrm.conversations
  AS RESTRICTIVE FOR SELECT TO authenticated
  USING (
    requested_agent_id IS NULL
    OR requested_agent_id = (SELECT auth.uid())
    OR coalesce((SELECT wacrm.current_user_role()), '') <> 'agent'
  );

DROP POLICY IF EXISTS mention_queue_private_update ON wacrm.conversations;
CREATE POLICY mention_queue_private_update ON wacrm.conversations
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (
    requested_agent_id IS NULL
    OR requested_agent_id = (SELECT auth.uid())
    OR coalesce((SELECT wacrm.current_user_role()), '') <> 'agent'
  )
  WITH CHECK (
    requested_agent_id IS NULL
    OR requested_agent_id = (SELECT auth.uid())
    OR coalesce((SELECT wacrm.current_user_role()), '') <> 'agent'
  );

-- Once someone actually assumes or closes the conversation, the pending
-- reservation must disappear. Applies to all existing assignment paths.
CREATE OR REPLACE FUNCTION wacrm.clear_mention_reservation_on_takeover()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.assigned_agent_id IS NOT NULL OR NEW.status = 'closed' THEN
    NEW.requested_agent_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_clear_mention_reservation ON wacrm.conversations;
CREATE TRIGGER trg_clear_mention_reservation
  BEFORE INSERT OR UPDATE OF assigned_agent_id, status ON wacrm.conversations
  FOR EACH ROW EXECUTE FUNCTION wacrm.clear_mention_reservation_on_takeover();

-- Direct browser clients may update other conversation columns, but never
-- forge or clear a routing reservation. The routing RPC runs as service_role.
CREATE OR REPLACE FUNCTION wacrm.guard_mention_reservation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' AND NEW.requested_agent_id IS NOT NULL THEN
      RAISE EXCEPTION 'reserved agent is server-managed' USING ERRCODE = '42501';
    ELSIF TG_OP = 'UPDATE' AND NEW.requested_agent_id IS DISTINCT FROM OLD.requested_agent_id THEN
      RAISE EXCEPTION 'reserved agent is server-managed' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_guard_mention_reservation ON wacrm.conversations;
CREATE TRIGGER trg_guard_mention_reservation
  BEFORE INSERT OR UPDATE OF requested_agent_id ON wacrm.conversations
  FOR EACH ROW EXECUTE FUNCTION wacrm.guard_mention_reservation();

-- Atomic routing + flow stop. Server-only RPC; never callable with anon or a
-- user's JWT. Locks the conversation to prevent concurrent claims/reroutes.
-- Returns selected user_id on success, NULL on no match/ineligible conversation.
CREATE OR REPLACE FUNCTION wacrm.route_conversation_to_mentioned_agent(
  p_account_id uuid,
  p_conversation_id uuid,
  p_alias text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_agent_id uuid;
  v_status text;
  v_assigned_agent_id uuid;
  v_current_team_id uuid;
  v_target_team_id uuid;
BEGIN
  IF p_alias IS NULL OR p_alias !~ '^[a-z_][a-z0-9_]{1,31}$' THEN
    RETURN NULL;
  END IF;

  SELECT p.user_id INTO v_agent_id
  FROM wacrm.profiles p
  WHERE p.account_id = p_account_id
    AND p.account_role = 'agent'::wacrm.account_role_enum
    AND p.mention_alias = p_alias
  LIMIT 1;
  IF v_agent_id IS NULL THEN RETURN NULL; END IF;

  SELECT c.status, c.assigned_agent_id, c.team_id
    INTO v_status, v_assigned_agent_id, v_current_team_id
  FROM wacrm.conversations c
  WHERE c.account_id = p_account_id AND c.id = p_conversation_id
  FOR UPDATE;
  IF NOT FOUND OR v_status = 'closed' OR v_assigned_agent_id IS NOT NULL THEN
    RETURN NULL;
  END IF;

  -- Preserve the current team when the target belongs to it; otherwise
  -- route to the target's earliest team. Null means personal waiting queue.
  SELECT tm.team_id INTO v_target_team_id
  FROM wacrm.team_members tm
  JOIN wacrm.teams t ON t.id = tm.team_id AND t.account_id = p_account_id
  WHERE tm.user_id = v_agent_id
  ORDER BY CASE WHEN tm.team_id = v_current_team_id THEN 0 ELSE 1 END,
           tm.created_at, tm.team_id
  LIMIT 1;

  UPDATE wacrm.conversations
  SET status = 'pending',
      assigned_agent_id = NULL,
      requested_agent_id = v_agent_id,
      team_id = v_target_team_id,
      updated_at = now()
  WHERE account_id = p_account_id AND id = p_conversation_id;

  UPDATE wacrm.flow_runs
  SET status = 'handed_off', end_reason = 'agent_mention', ended_at = now()
  WHERE account_id = p_account_id AND conversation_id = p_conversation_id
    AND status = 'active';

  RETURN v_agent_id;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.route_conversation_to_mentioned_agent(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.route_conversation_to_mentioned_agent(uuid, uuid, text)
  TO service_role;

DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version)
    VALUES ('376_agent_mention_queue') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- POST-CHECK:
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema='wacrm' AND table_name='conversations'
--    AND column_name='requested_agent_id';
-- SELECT policyname FROM pg_policies WHERE schemaname='wacrm'
--   AND tablename='conversations' AND policyname LIKE 'mention_queue_%';
-- SELECT has_function_privilege('anon',
--   'wacrm.route_conversation_to_mentioned_agent(uuid,uuid,text)','EXECUTE') AS anon_can_execute;
-- Expected: false.
