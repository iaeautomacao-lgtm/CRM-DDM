-- Migration 097: RPC de ações de frontend (aba "Ações" de /ddm-logs)
-- com nome/email do usuário via LEFT JOIN em profiles.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

-- getActionsTab() (route.ts) fazia SELECT * FROM system_logs sem
-- join nenhum — a aba só conseguia mostrar user_id truncado, nunca o
-- nome. LEFT JOIN (não INNER) porque user_id pode ser NULL (evento
-- sem sessão resolvida) ou apontar pra um usuário sem profile — nesses
-- casos user_name/user_email saem NULL em vez de a linha inteira
-- sumir da lista. Também assume o filtro de p_action (antes client-
-- side na UI, agora server-side) e a paginação por cursor que antes
-- vinha do query builder.
CREATE OR REPLACE FUNCTION wacrm.get_action_logs(
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
  WHERE sl.source = 'frontend'
    AND sl.action IS NOT NULL
    AND sl.created_at >= p_from
    AND (p_cursor IS NULL OR sl.created_at < p_cursor)
    AND (p_user_id IS NULL OR sl.user_id = p_user_id)
    AND (p_action IS NULL OR sl.action = p_action)
  ORDER BY sl.created_at DESC
  LIMIT p_limit;
$$;
