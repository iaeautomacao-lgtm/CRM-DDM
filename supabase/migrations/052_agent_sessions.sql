-- ============================================================
-- 052_agent_sessions.sql — Agentes report: login/logout session
-- history, derived from wacrm.member_presence's heartbeat.
--
-- Passo 0 finding (see touch_presence, 024_member_presence.sql):
-- it's a pure upsert (`INSERT ... ON CONFLICT (user_id) DO UPDATE`).
-- member_presence has existed since migration 024, so almost every
-- agent already has a row — meaning the INSERT trigger case below
-- fires only for a brand-new user's very first-ever heartbeat, never
-- for a returning agent. The UPDATE case with a stale `last_seen_at`
-- gap is therefore the PRIMARY way "a new session started" gets
-- detected for existing agents, not a fallback.
--
-- There is no logout_presence/equivalent (confirmed: no other
-- %presence% function exists) — the client never signals "I'm
-- logging out," it just stops heartbeating. So "logout" here is
-- always inferred, never a direct event: only the gap-detection case
-- below closes a session, when a returning heartbeat notices the
-- previous one is older than the stale threshold — i.e. a real
-- disconnect (tab closed, machine slept/lost network), not an
-- online→away flip. The client keeps heartbeating while 'away'
-- (PresenceHeartbeat comment, src/components/presence/
-- presence-heartbeat.tsx) — idle/hidden-tab periods (5 min idle,
-- backgrounded tab) do NOT close or split a session, by design: one
-- workday with idle gaps (lunch, a meeting, tab-switching) still
-- produces one continuous agent_sessions row, matching what a
-- "Login" report reader expects. (An earlier draft of this migration
-- also closed/reopened a session on every online↔away flip — removed
-- per review: it fragmented one real session into many.)
--
-- Stale threshold: uses OFFLINE_AFTER_MS's value (75s — 2.5 missed
-- 30s heartbeats, src/lib/presence.ts:23), the app's own existing
-- definition of "gone", instead of an arbitrary new number — keeps
-- the session boundary consistent with what the UI already calls
-- offline.
--
-- Idempotent — safe to run multiple times. Not applied to the DB by
-- this session; file only.
-- ============================================================

SET search_path TO wacrm, public, extensions;

-- ---- table -----------------------------------------------------
CREATE TABLE IF NOT EXISTS wacrm.agent_sessions (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id    UUID        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  logged_in_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  logged_out_at TIMESTAMPTZ,  -- NULL = session still open/active
  -- NULL while open — see header re: the DEFAULT that used to live
  -- here mislabeling every freshly-opened session as already ended.
  cause         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_sessions_account_user
  ON wacrm.agent_sessions(account_id, user_id, logged_in_at DESC);
CREATE INDEX IF NOT EXISTS agent_sessions_active
  ON wacrm.agent_sessions(user_id, logged_out_at)
  WHERE logged_out_at IS NULL;

-- ---- RLS ---------------------------------------------------
ALTER TABLE wacrm.agent_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_sessions_select ON wacrm.agent_sessions;
CREATE POLICY agent_sessions_select ON wacrm.agent_sessions FOR SELECT
  USING (is_account_member(account_id));

-- No INSERT/UPDATE/DELETE policy — writes only happen via the
-- SECURITY DEFINER trigger below, which bypasses RLS (table owner),
-- same append-only shape as audit_logs (050) and flow_run_events (010).

-- ============================================================
-- trigger function: detects session start/end from member_presence
-- heartbeats.
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.handle_presence_session()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_stale_threshold INTERVAL := INTERVAL '75 seconds'; -- matches OFFLINE_AFTER_MS
BEGIN
  -- Brand-new user_id, first heartbeat ever (see header — the only
  -- case this fires for an existing agent's presence row).
  IF TG_OP = 'INSERT' THEN
    INSERT INTO wacrm.agent_sessions (account_id, user_id, logged_in_at)
    VALUES (NEW.account_id, NEW.user_id, NOW());
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN

    -- Returning heartbeat after a gap ≥ threshold: whatever session
    -- was left open is stale/dangling — close it at the last real
    -- heartbeat we saw (best available approximation of when they
    -- actually left, not "now"), then open a fresh session.
    IF OLD.last_seen_at < NOW() - v_stale_threshold
       AND NEW.status = 'online' THEN

      UPDATE wacrm.agent_sessions
      SET logged_out_at = OLD.last_seen_at,
          cause = 'Sessão expirada'
      WHERE user_id = NEW.user_id
        AND logged_out_at IS NULL;

      INSERT INTO wacrm.agent_sessions (account_id, user_id, logged_in_at)
      VALUES (NEW.account_id, NEW.user_id, NOW());
      RETURN NEW;
    END IF;

  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_presence_session ON wacrm.member_presence;
CREATE TRIGGER trg_presence_session
  AFTER INSERT OR UPDATE ON wacrm.member_presence
  FOR EACH ROW EXECUTE FUNCTION wacrm.handle_presence_session();

-- ============================================================
-- get_agent_sessions_report — the report's one read path.
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.get_agent_sessions_report(
  p_account_id UUID,
  p_date_from  TIMESTAMPTZ,
  p_date_to    TIMESTAMPTZ,
  p_user_id    UUID DEFAULT NULL
)
RETURNS TABLE (
  session_id    UUID,
  user_id       UUID,
  user_name     TEXT,
  user_email    TEXT,
  logged_in_at  TIMESTAMPTZ,
  logged_out_at TIMESTAMPTZ,
  duration_sec  NUMERIC,
  cause         TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
  SELECT
    s.id,
    s.user_id,
    p.full_name,
    u.email,
    s.logged_in_at,
    s.logged_out_at,
    EXTRACT(EPOCH FROM (COALESCE(s.logged_out_at, NOW()) - s.logged_in_at)) AS duration_sec,
    s.cause
  FROM wacrm.agent_sessions s
  JOIN wacrm.profiles p ON p.user_id = s.user_id
  JOIN auth.users u ON u.id = s.user_id
  WHERE s.account_id = p_account_id
    AND is_account_member(p_account_id)
    AND s.logged_in_at >= p_date_from
    AND s.logged_in_at <= p_date_to
    AND (p_user_id IS NULL OR s.user_id = p_user_id)
  ORDER BY s.logged_in_at DESC
  LIMIT 500;
$$;

ALTER FUNCTION wacrm.get_agent_sessions_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.get_agent_sessions_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.get_agent_sessions_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ, UUID) TO authenticated;
