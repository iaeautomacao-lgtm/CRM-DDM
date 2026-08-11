-- ============================================================
-- 053_conversations_report_rpc.sql — Conversas report: paginated
-- conversation list with filters, backing /relatorios/conversas.
--
-- Passo 0 re-confirmed conversations.status has THREE values
-- ('open'|'pending'|'closed'), not two — p_status='open' below means
-- "not closed" (covers open + pending) rather than an exact match,
-- otherwise 'pending' conversations would vanish from the "Em
-- andamento" filter instead of showing under it.
--
-- Bug fixed vs. the original draft: it LEFT JOINed messages directly
-- onto conversations and GROUP BY'd including m.id, which explodes to
-- one row per (conversation, message) pair before a DISTINCT
-- recollapses it — COUNT(*) OVER() computed on that exploded set
-- counts message rows, not conversations, so the footer's total_count
-- would be wildly inflated. message_count is now a correlated
-- subquery (one row per conversation throughout), and total_count is
-- COUNT(*) OVER() taken over `filtered` before LIMIT/OFFSET — correct
-- regardless of page size.
--
-- Idempotent — safe to run multiple times. Not applied to the DB by
-- this session; file only.
-- ============================================================

SET search_path TO wacrm, public, extensions;

CREATE OR REPLACE FUNCTION wacrm.get_conversations_report(
  p_account_id    UUID,
  p_date_from     TIMESTAMPTZ,
  p_date_to       TIMESTAMPTZ,
  p_scope         TEXT DEFAULT 'created',  -- 'created' | 'closed'
  p_waha_session  TEXT DEFAULT NULL,
  p_agent_id      UUID DEFAULT NULL,
  p_team_id       UUID DEFAULT NULL,
  p_status        TEXT DEFAULT NULL,       -- 'open' (= not closed) | 'closed' | NULL = todos
  p_search        TEXT DEFAULT NULL,       -- busca em contact name/phone
  p_limit         INT  DEFAULT 60,
  p_offset        INT  DEFAULT 0
)
RETURNS TABLE (
  conversation_id UUID,
  contact_name    TEXT,
  contact_phone   TEXT,
  waha_session    TEXT,
  status          TEXT,
  agent_name      TEXT,
  team_name       TEXT,
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  message_count   BIGINT,
  total_count     BIGINT   -- total sem paginação (para o rodapé)
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
  WITH filtered AS (
    SELECT
      c.id,
      ct.name  AS contact_name,
      ct.phone AS contact_phone,
      c.waha_session,
      c.status,
      p.full_name AS agent_name,
      t.name      AS team_name,
      c.created_at AS started_at,
      CASE WHEN c.status = 'closed' THEN c.updated_at ELSE NULL END AS ended_at,
      (SELECT COUNT(*) FROM wacrm.messages m WHERE m.conversation_id = c.id) AS message_count
    FROM wacrm.conversations c
    LEFT JOIN wacrm.contacts ct ON ct.id = c.contact_id
    LEFT JOIN wacrm.profiles p  ON p.user_id = c.assigned_agent_id
    LEFT JOIN wacrm.teams t     ON t.id = c.team_id
    WHERE c.account_id = p_account_id
      AND is_account_member(p_account_id)
      -- Escopo: iniciadas ou finalizadas no período
      AND (
        CASE
          WHEN p_scope = 'closed'
            THEN c.status = 'closed' AND c.updated_at BETWEEN p_date_from AND p_date_to
          ELSE c.created_at BETWEEN p_date_from AND p_date_to
        END
      )
      AND (p_waha_session IS NULL OR c.waha_session = p_waha_session)
      AND (p_agent_id     IS NULL OR c.assigned_agent_id = p_agent_id)
      AND (p_team_id      IS NULL OR c.team_id = p_team_id)
      -- 'open' means "not closed" — status has 3 values (open/pending/
      -- closed); an exact match on 'open' would silently drop 'pending'
      -- conversations out of the "Em andamento" filter.
      AND (
        p_status IS NULL
        OR (p_status = 'closed' AND c.status = 'closed')
        OR (p_status = 'open' AND c.status <> 'closed')
      )
      AND (
        p_search IS NULL
        OR ct.name ILIKE '%' || p_search || '%'
        OR ct.phone ILIKE '%' || p_search || '%'
        OR ct.phone_normalized LIKE '%' || regexp_replace(p_search, '\D', '', 'g') || '%'
      )
  )
  SELECT
    id AS conversation_id,
    contact_name,
    contact_phone,
    waha_session,
    status,
    agent_name,
    team_name,
    started_at,
    ended_at,
    message_count,
    COUNT(*) OVER () AS total_count
  FROM filtered
  ORDER BY started_at DESC
  LIMIT p_limit OFFSET p_offset;
$$;

ALTER FUNCTION wacrm.get_conversations_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID, UUID, TEXT, TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.get_conversations_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID, UUID, TEXT, TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.get_conversations_report(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, UUID, UUID, TEXT, TEXT, INT, INT) TO authenticated;
