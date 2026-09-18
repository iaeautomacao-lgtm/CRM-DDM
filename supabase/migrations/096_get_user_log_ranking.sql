-- Migration 096: RPC de ranking de erros por usuário para /ddm-logs.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

-- GROUP BY + COUNT(*) FILTER não dá pra expressar no query builder do
-- Supabase JS (só filtros simples/paginação) — a aba "Por Usuário" de
-- /ddm-logs precisa dessa agregação pronta do banco. LANGUAGE sql (não
-- plpgsql): é uma única query, sem controle de fluxo.
CREATE OR REPLACE FUNCTION wacrm.get_user_log_ranking(p_from timestamptz)
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
    COUNT(*) FILTER (WHERE sl.level IN ('error', 'critical')) AS error_count,
    COUNT(*) AS total_events,
    MAX(sl.created_at) AS last_seen
  FROM wacrm.system_logs sl
  JOIN wacrm.profiles p ON p.user_id = sl.user_id
  WHERE sl.user_id IS NOT NULL
    AND sl.created_at >= p_from
  GROUP BY sl.user_id, p.full_name, p.email
  ORDER BY error_count DESC
  LIMIT 50;
$$;
