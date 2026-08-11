-- ============================================================
-- 051_attendance_report_rpc.sql — Atendimentos report RPCs
--
-- Three read-only aggregation RPCs behind /relatorios/atendimentos,
-- so the client never pulls raw conversations/messages rows — all
-- grouping/summing happens in Postgres.
--
-- Schema check (Passo 0) against the real wacrm.conversations /
-- wacrm.messages columns — NOT assumed:
--   - conversations has no resolved_at (only created_at/updated_at),
--     no origin/direction/initiated_by, and no transfer-history
--     column. transfer-dialog.tsx only UPDATEs assigned_agent_id/
--     team_id directly (src/lib/conversations/actions.ts) — there is
--     no persisted "this conversation was transferred" fact anywhere.
--   - messages DOES have content_type ('text'|'image'|'document'|
--     'audio'|'video'|'location'|'template'), so "Mídia" (non-text
--     messages) is real data, not the "-" fallback the page spec
--     allowed for when no type column exists.
--
-- Real vs proxy vs zero, per indicator:
--   finalized       real   — status = 'closed'
--   active          real   — status <> 'closed'
--   transferred     ZERO   — no transfer field exists (documented)
--   inbound         ZERO   — no origin/direction field exists (documented)
--   messages_count  real   — COUNT(*) of messages on conversations in period
--   media_count     real   — COUNT(*) WHERE content_type <> 'text'
--   tta_seconds     real   — SUM(updated_at - created_at), status='closed'
--                            (updated_at stands in for resolved_at, which
--                            doesn't exist — per the page's own instruction)
--   tma_seconds     real   — AVG of the same
--   ttp_seconds     real   — SUM(first agent message.created_at - conv.created_at)
--   tmp_seconds     real   — AVG of the same
--   tme_seconds     PROXY  — same value as tmp_seconds. A true "wait between
--                            last customer message and the next agent reply"
--                            metric needs a per-message-pair window function
--                            that was judged not worth the complexity yet
--                            (explicitly allowed as an acceptable simplification
--                            by the page spec) — first-response time is used
--                            as the stand-in for every "wait" indicator.
--   tmr_seconds     PROXY  — same value as tme_seconds (so also tmp_seconds).
--
-- Security: all three are SECURITY DEFINER (so they can read across
-- the account's rows in one aggregate query instead of relying on
-- RLS per-row, matching set_member_team's rationale in 049_teams.sql)
-- but that means RLS on conversations/messages is bypassed — each
-- function guards itself with `is_account_member(p_account_id)` in
-- its own WHERE clause so a caller who isn't a member of the account
-- they're asking about gets zero rows back, never another account's
-- data. This check was not in the original function skeleton and was
-- added here because a SECURITY DEFINER function with no such guard
-- would let any authenticated user pass an arbitrary p_account_id and
-- read another account's attendance data.
--
-- Idempotent — safe to run multiple times. Not applied to the DB by
-- this session; file only.
-- ============================================================

SET search_path TO wacrm, public, extensions;

-- ============================================================
-- get_attendance_report_by_team
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.get_attendance_report_by_team(
  p_account_id  UUID,
  p_date_from   TIMESTAMPTZ,
  p_date_to     TIMESTAMPTZ
)
RETURNS TABLE (
  team_id        UUID,
  team_name      TEXT,
  finalized      BIGINT,
  transferred    BIGINT,
  active         BIGINT,
  inbound        BIGINT,
  messages_count BIGINT,
  media_count    BIGINT,
  tta_seconds    NUMERIC,
  tma_seconds    NUMERIC,
  ttp_seconds    NUMERIC,
  tmp_seconds    NUMERIC,
  tme_seconds    NUMERIC,
  tmr_seconds    NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
  WITH period_conversations AS (
    SELECT c.id, c.team_id, c.status, c.created_at, c.updated_at
    FROM wacrm.conversations c
    WHERE c.account_id = p_account_id
      AND is_account_member(p_account_id)
      AND c.created_at >= p_date_from
      AND c.created_at <= p_date_to
  ),
  first_agent_reply AS (
    SELECT m.conversation_id, MIN(m.created_at) AS first_reply_at
    FROM wacrm.messages m
    JOIN period_conversations pc ON pc.id = m.conversation_id
    WHERE m.sender_type = 'agent'
    GROUP BY m.conversation_id
  ),
  message_stats AS (
    SELECT
      m.conversation_id,
      COUNT(*) AS msg_count,
      COUNT(*) FILTER (WHERE m.content_type <> 'text') AS media_count
    FROM wacrm.messages m
    JOIN period_conversations pc ON pc.id = m.conversation_id
    GROUP BY m.conversation_id
  )
  -- LEFT JOIN teams (not the reverse) so conversations with no
  -- team_id yet (migration 049: nothing wrote it until Monitoramento's
  -- "Equipes" tab/transfer dialog started setting it) form their own
  -- group — team_id/team_name NULL, which the client renders as
  -- "Sem equipe" — instead of silently disappearing from the report.
  SELECT
    t.id                                                                                AS team_id,
    t.name                                                                               AS team_name,
    COUNT(*) FILTER (WHERE pc.status = 'closed')                                        AS finalized,
    0::BIGINT                                                                            AS transferred,
    COUNT(*) FILTER (WHERE pc.status <> 'closed')                                        AS active,
    0::BIGINT                                                                            AS inbound,
    COALESCE(SUM(ms.msg_count), 0)                                                       AS messages_count,
    COALESCE(SUM(ms.media_count), 0)                                                     AS media_count,
    COALESCE(SUM(EXTRACT(EPOCH FROM (pc.updated_at - pc.created_at))) FILTER (WHERE pc.status = 'closed'), 0)  AS tta_seconds,
    COALESCE(AVG(EXTRACT(EPOCH FROM (pc.updated_at - pc.created_at))) FILTER (WHERE pc.status = 'closed'), 0)  AS tma_seconds,
    COALESCE(SUM(EXTRACT(EPOCH FROM (fr.first_reply_at - pc.created_at))), 0)             AS ttp_seconds,
    COALESCE(AVG(EXTRACT(EPOCH FROM (fr.first_reply_at - pc.created_at))), 0)             AS tmp_seconds,
    COALESCE(AVG(EXTRACT(EPOCH FROM (fr.first_reply_at - pc.created_at))), 0)             AS tme_seconds,
    COALESCE(AVG(EXTRACT(EPOCH FROM (fr.first_reply_at - pc.created_at))), 0)             AS tmr_seconds
  FROM period_conversations pc
  LEFT JOIN wacrm.teams t ON t.id = pc.team_id
  LEFT JOIN first_agent_reply fr ON fr.conversation_id = pc.id
  LEFT JOIN message_stats ms ON ms.conversation_id = pc.id
  GROUP BY t.id, t.name;
$$;

ALTER FUNCTION wacrm.get_attendance_report_by_team(UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.get_attendance_report_by_team(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.get_attendance_report_by_team(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ============================================================
-- get_attendance_report_by_agent — same shape, grouped by
-- assigned_agent_id + profiles instead of team_id + teams.
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.get_attendance_report_by_agent(
  p_account_id  UUID,
  p_date_from   TIMESTAMPTZ,
  p_date_to     TIMESTAMPTZ
)
RETURNS TABLE (
  agent_id       UUID,
  agent_name     TEXT,
  finalized      BIGINT,
  transferred    BIGINT,
  active         BIGINT,
  inbound        BIGINT,
  messages_count BIGINT,
  media_count    BIGINT,
  tta_seconds    NUMERIC,
  tma_seconds    NUMERIC,
  ttp_seconds    NUMERIC,
  tmp_seconds    NUMERIC,
  tme_seconds    NUMERIC,
  tmr_seconds    NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
  WITH period_conversations AS (
    SELECT c.id, c.assigned_agent_id, c.status, c.created_at, c.updated_at
    FROM wacrm.conversations c
    WHERE c.account_id = p_account_id
      AND is_account_member(p_account_id)
      AND c.created_at >= p_date_from
      AND c.created_at <= p_date_to
  ),
  first_agent_reply AS (
    SELECT m.conversation_id, MIN(m.created_at) AS first_reply_at
    FROM wacrm.messages m
    JOIN period_conversations pc ON pc.id = m.conversation_id
    WHERE m.sender_type = 'agent'
    GROUP BY m.conversation_id
  ),
  message_stats AS (
    SELECT
      m.conversation_id,
      COUNT(*) AS msg_count,
      COUNT(*) FILTER (WHERE m.content_type <> 'text') AS media_count
    FROM wacrm.messages m
    JOIN period_conversations pc ON pc.id = m.conversation_id
    GROUP BY m.conversation_id
  )
  -- LEFT JOIN profiles so unassigned conversations (assigned_agent_id
  -- IS NULL) group under agent_id/agent_name NULL ("Sem agente")
  -- instead of vanishing from the report.
  SELECT
    p.user_id                                                                            AS agent_id,
    p.full_name                                                                          AS agent_name,
    COUNT(*) FILTER (WHERE pc.status = 'closed')                                        AS finalized,
    0::BIGINT                                                                            AS transferred,
    COUNT(*) FILTER (WHERE pc.status <> 'closed')                                        AS active,
    0::BIGINT                                                                            AS inbound,
    COALESCE(SUM(ms.msg_count), 0)                                                       AS messages_count,
    COALESCE(SUM(ms.media_count), 0)                                                     AS media_count,
    COALESCE(SUM(EXTRACT(EPOCH FROM (pc.updated_at - pc.created_at))) FILTER (WHERE pc.status = 'closed'), 0)  AS tta_seconds,
    COALESCE(AVG(EXTRACT(EPOCH FROM (pc.updated_at - pc.created_at))) FILTER (WHERE pc.status = 'closed'), 0)  AS tma_seconds,
    COALESCE(SUM(EXTRACT(EPOCH FROM (fr.first_reply_at - pc.created_at))), 0)             AS ttp_seconds,
    COALESCE(AVG(EXTRACT(EPOCH FROM (fr.first_reply_at - pc.created_at))), 0)             AS tmp_seconds,
    COALESCE(AVG(EXTRACT(EPOCH FROM (fr.first_reply_at - pc.created_at))), 0)             AS tme_seconds,
    COALESCE(AVG(EXTRACT(EPOCH FROM (fr.first_reply_at - pc.created_at))), 0)             AS tmr_seconds
  FROM period_conversations pc
  LEFT JOIN wacrm.profiles p ON p.user_id = pc.assigned_agent_id
  LEFT JOIN first_agent_reply fr ON fr.conversation_id = pc.id
  LEFT JOIN message_stats ms ON ms.conversation_id = pc.id
  GROUP BY p.user_id, p.full_name;
$$;

ALTER FUNCTION wacrm.get_attendance_report_by_agent(UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.get_attendance_report_by_agent(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.get_attendance_report_by_agent(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

-- ============================================================
-- get_attendance_summary — the 3 top KPI cards.
-- active_count / inbound_count are ZERO — no origin/direction field
-- exists (see header). Kept as output columns (rather than dropped)
-- so the page's TypeScript type is stable if a future migration adds
-- real data for them.
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.get_attendance_summary(
  p_account_id  UUID,
  p_date_from   TIMESTAMPTZ,
  p_date_to     TIMESTAMPTZ
)
RETURNS TABLE (
  total_agents      BIGINT,
  human_messages    BIGINT,
  human_attendances BIGINT,
  bot_messages      BIGINT,
  bot_attendances   BIGINT,
  active_count      BIGINT,
  inbound_count     BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
  WITH period_conversations AS (
    SELECT c.id, c.assigned_agent_id
    FROM wacrm.conversations c
    WHERE c.account_id = p_account_id
      AND is_account_member(p_account_id)
      AND c.created_at >= p_date_from
      AND c.created_at <= p_date_to
  ),
  conv_msg_stats AS (
    SELECT
      pc.id,
      COUNT(*) FILTER (WHERE m.sender_type = 'agent') AS agent_msgs,
      COUNT(*) FILTER (WHERE m.sender_type = 'bot')   AS bot_msgs
    FROM period_conversations pc
    LEFT JOIN wacrm.messages m ON m.conversation_id = pc.id
    GROUP BY pc.id
  )
  SELECT
    COUNT(DISTINCT pc.assigned_agent_id)                    AS total_agents,
    COALESCE(SUM(cms.agent_msgs), 0)                        AS human_messages,
    COUNT(*) FILTER (WHERE cms.agent_msgs > 0)              AS human_attendances,
    COALESCE(SUM(cms.bot_msgs), 0)                          AS bot_messages,
    COUNT(*) FILTER (WHERE cms.agent_msgs = 0)              AS bot_attendances,
    0::BIGINT                                               AS active_count,
    0::BIGINT                                               AS inbound_count
  FROM period_conversations pc
  JOIN conv_msg_stats cms ON cms.id = pc.id;
$$;

ALTER FUNCTION wacrm.get_attendance_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.get_attendance_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.get_attendance_summary(UUID, TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;
