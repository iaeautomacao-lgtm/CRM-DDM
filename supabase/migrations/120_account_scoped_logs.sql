-- Account-scoped administrative log RPCs. Legacy functions remain internal.
BEGIN;
CREATE OR REPLACE FUNCTION wacrm.get_user_log_ranking_for_account(p_account_id uuid, p_from timestamptz)
RETURNS TABLE (
  user_id       uuid,
  full_name     text,
  email         text,
  error_count   bigint,
  total_events  bigint,
  last_seen     timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    sl.user_id,
    p.full_name,
    p.email,
    COUNT(*) FILTER (WHERE sl.account_id = p_account_id AND sl.level IN ('error', 'critical')) AS error_count,
    COUNT(*) AS total_events,
    MAX(sl.created_at) AS last_seen
  FROM wacrm.system_logs sl
  JOIN wacrm.profiles p ON p.user_id = sl.user_id
  WHERE sl.account_id = p_account_id AND sl.user_id IS NOT NULL
    AND sl.created_at >= p_from
  GROUP BY sl.user_id, p.full_name, p.email
  ORDER BY error_count DESC
  LIMIT 50;
$$;

CREATE OR REPLACE FUNCTION wacrm.get_action_logs_for_account(p_account_id uuid, 
  p_from      timestamptz,
  p_cursor    timestamptz DEFAULT NULL,
  p_limit     integer DEFAULT 200,
  p_user_id   uuid DEFAULT NULL,
  p_action    text DEFAULT NULL
)
RETURNS TABLE (
  id          uuid,
  account_id  uuid,
  user_id     uuid,
  page        text,
  action      text,
  level       text,
  source      text,
  event       text,
  message     text,
  payload     jsonb,
  created_at  timestamptz,
  user_name   text,
  user_email  text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    sl.id,
    sl.account_id,
    sl.user_id,
    sl.page,
    sl.action,
    sl.level,
    sl.source,
    sl.event,
    sl.message,
    sl.payload,
    sl.created_at,
    p.full_name AS user_name,
    p.email AS user_email
  FROM wacrm.system_logs sl
  LEFT JOIN wacrm.profiles p ON p.user_id = sl.user_id
  WHERE sl.account_id = p_account_id AND sl.source = 'frontend'
    AND sl.action IS NOT NULL
    AND sl.created_at >= p_from
    AND (p_cursor IS NULL OR sl.created_at < p_cursor)
    AND (p_user_id IS NULL OR sl.user_id = p_user_id)
    AND (p_action IS NULL OR sl.action = p_action)
  ORDER BY sl.created_at DESC
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION wacrm.get_feedback_logs_for_account(p_account_id uuid, 
  p_from      timestamptz,
  p_cursor    timestamptz DEFAULT NULL,
  p_limit     integer DEFAULT 200
)
RETURNS TABLE (
  id          uuid,
  account_id  uuid,
  user_id     uuid,
  page        text,
  level       text,
  source      text,
  event       text,
  message     text,
  payload     jsonb,
  created_at  timestamptz,
  user_name   text,
  user_email  text
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    sl.id,
    sl.account_id,
    sl.user_id,
    sl.page,
    sl.level,
    sl.source,
    sl.event,
    sl.message,
    sl.payload,
    sl.created_at,
    p.full_name AS user_name,
    p.email AS user_email
  FROM wacrm.system_logs sl
  LEFT JOIN wacrm.profiles p ON p.user_id = sl.user_id
  WHERE sl.account_id = p_account_id AND sl.source = 'feedback'
    AND sl.created_at >= p_from
    AND (p_cursor IS NULL OR sl.created_at < p_cursor)
  ORDER BY sl.created_at DESC
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION wacrm.get_user_log_ranking_for_account(uuid,timestamptz), wacrm.get_action_logs_for_account(uuid,timestamptz,timestamptz,integer,uuid,text), wacrm.get_feedback_logs_for_account(uuid,timestamptz,timestamptz,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.get_user_log_ranking_for_account(uuid,timestamptz), wacrm.get_action_logs_for_account(uuid,timestamptz,timestamptz,integer,uuid,text), wacrm.get_feedback_logs_for_account(uuid,timestamptz,timestamptz,integer) TO service_role;
REVOKE ALL ON wacrm.cron_locks FROM PUBLIC, anon, authenticated;
ALTER TABLE wacrm.cron_locks ENABLE ROW LEVEL SECURITY;
GRANT ALL ON wacrm.cron_locks TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
