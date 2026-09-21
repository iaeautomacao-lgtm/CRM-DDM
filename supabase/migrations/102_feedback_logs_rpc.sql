-- Migration 102: RPC de feedbacks de usuário (aba "Feedbacks" de
-- /ddm-logs) com nome/email do usuário via LEFT JOIN em profiles.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

-- Mesmo motivo/padrão da migration 097 (get_action_logs): system_logs.
-- user_id não tem FK exposta a profiles pro PostgREST embedar
-- automático, então a resolução de nome precisa vir de uma RPC com
-- LEFT JOIN explícito (LEFT, não INNER — user_id pode ser NULL ou
-- apontar pra um usuário sem profile).
CREATE OR REPLACE FUNCTION wacrm.get_feedback_logs(
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
  WHERE sl.source = 'feedback'
    AND sl.created_at >= p_from
    AND (p_cursor IS NULL OR sl.created_at < p_cursor)
  ORDER BY sl.created_at DESC
  LIMIT p_limit;
$$;
