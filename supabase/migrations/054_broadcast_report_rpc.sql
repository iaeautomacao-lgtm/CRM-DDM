-- ============================================================
-- 054_broadcast_report_rpc.sql — Envio em Lote report RPCs
-- (Disparador: campaigns / blacklist / disp_message_queue /
-- campaign_metrics).
--
-- wacrm.campaigns has NO account_id column and RLS is disabled on all
-- four disparador tables (disparador_schema.sql: "Desativar RLS ...
-- para compatibilidade") — migration 040_disparador_account_scoping.sql
-- was written to fix this but was never applied (confirmed via
-- src/app/api/disparador/campaigns/[id]/route.ts:42-43, which scopes
-- via created_by -> profiles.account_id specifically because "migration
-- 040 not applied"). These RPCs use that exact same scoping path.
--
-- Schema corrections vs. the original draft (Passo 0):
--   - whatsapp_config has no `session_name` column — the real column
--     is `waha_session` (027_waha_integration.sql).
--   - campaign_metrics.total_entregues / total_lidos are real columns
--     but are NEVER written by any code path (grepped worker.ts,
--     cron/route.ts, campaigns/[id]/*.ts — only total_enviados and
--     total_contatos are ever set). Kept as real output columns
--     (truthfully always 0 today, not fabricated) rather than dropped,
--     so the report doesn't need a shape change if a future read-
--     receipt webhook starts populating them.
--   - disp_message_queue.status NEVER takes 'entregue' or 'lido' —
--     the real values written by the worker/cron are 'agendado',
--     'enviando', 'enviado', 'erro', 'cancelado' (grepped
--     src/lib/disparador/worker.ts and src/app/api/disparador/**).
--     get_campaign_report_detail's send/error counts are computed
--     live from disp_message_queue by status, not from
--     campaign_metrics.total_enviados/total_erros (total_erros is
--     never incremented either, so it would always read 0 and hide
--     real failures).
--
-- Idempotent — safe to run multiple times. Not applied to the DB by
-- this session; file only.
-- ============================================================

SET search_path TO wacrm, public, extensions;

-- ============================================================
-- RPC 1: campaign list for the filter dropdown.
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.get_campaigns_for_report(
  p_account_id UUID
)
RETURNS TABLE (
  id         UUID,
  nome       TEXT,
  created_at TIMESTAMPTZ,
  status     TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
  SELECT c.id, c.nome, c.created_at, c.status
  FROM wacrm.campaigns c
  JOIN wacrm.profiles p ON p.user_id = c.created_by
  WHERE p.account_id = p_account_id
    AND is_account_member(p_account_id)
  ORDER BY c.created_at DESC
  LIMIT 200;
$$;

ALTER FUNCTION wacrm.get_campaigns_for_report(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.get_campaigns_for_report(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.get_campaigns_for_report(UUID) TO authenticated;

-- ============================================================
-- RPC 2: one campaign's header details + aggregated counts.
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.get_campaign_report_detail(
  p_campaign_id UUID,
  p_account_id  UUID
)
RETURNS TABLE (
  campaign_id       UUID,
  nome              TEXT,
  created_at        TIMESTAMPTZ,
  agendamento       TIMESTAMPTZ,
  created_by_name   TEXT,
  created_by_email  TEXT,
  session_name      TEXT,
  total_contatos    BIGINT,
  total_mensagens   BIGINT,
  total_agendados   BIGINT,
  total_enviando    BIGINT,
  total_enviados    BIGINT,
  total_erros       BIGINT,
  total_cancelados  BIGINT,
  total_entregues   BIGINT, -- always 0 today — see header
  total_lidos       BIGINT  -- always 0 today — see header
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
  SELECT
    c.id,
    c.nome,
    c.created_at,
    c.agendamento,
    p.full_name,
    u.email,
    wc.waha_session,
    COALESCE(m.total_contatos, 0),
    COALESCE(q.total_mensagens, 0),
    COALESCE(q.agendado, 0),
    COALESCE(q.enviando, 0),
    COALESCE(q.enviado, 0),
    COALESCE(q.erro, 0),
    COALESCE(q.cancelado, 0),
    COALESCE(m.total_entregues, 0),
    COALESCE(m.total_lidos, 0)
  FROM wacrm.campaigns c
  JOIN wacrm.profiles p ON p.user_id = c.created_by
  JOIN auth.users u ON u.id = c.created_by
  LEFT JOIN wacrm.campaign_metrics m ON m.campaign_id = c.id
  -- session_ids is a UUID[]; array subscripts are 1-indexed in
  -- Postgres. NULL/empty array yields NULL here, handled by the
  -- LEFT JOIN (session_name comes back NULL, not an error).
  LEFT JOIN wacrm.whatsapp_config wc ON wc.id = c.session_ids[1]
  LEFT JOIN (
    SELECT
      campaign_id,
      COUNT(*)                                    AS total_mensagens,
      COUNT(*) FILTER (WHERE status = 'agendado')  AS agendado,
      COUNT(*) FILTER (WHERE status = 'enviando')  AS enviando,
      COUNT(*) FILTER (WHERE status = 'enviado')   AS enviado,
      COUNT(*) FILTER (WHERE status = 'erro')      AS erro,
      COUNT(*) FILTER (WHERE status = 'cancelado') AS cancelado
    FROM wacrm.disp_message_queue
    WHERE campaign_id = p_campaign_id
    GROUP BY campaign_id
  ) q ON q.campaign_id = c.id
  WHERE c.id = p_campaign_id
    AND p.account_id = p_account_id
    AND is_account_member(p_account_id);
$$;

ALTER FUNCTION wacrm.get_campaign_report_detail(UUID, UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.get_campaign_report_detail(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.get_campaign_report_detail(UUID, UUID) TO authenticated;

-- ============================================================
-- RPC 3: paginated queue items (per-contact rows) for one campaign.
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.get_campaign_queue_items(
  p_campaign_id UUID,
  p_account_id  UUID,
  p_status      TEXT DEFAULT NULL,   -- 'agendado'|'enviando'|'enviado'|'erro'|'cancelado'|NULL
  p_search      TEXT DEFAULT NULL,   -- busca em contact name/phone
  p_limit       INT  DEFAULT 60,
  p_offset      INT  DEFAULT 0
)
RETURNS TABLE (
  item_id        UUID,
  sent_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ,
  contact_name   TEXT,
  contact_phone  TEXT,
  status         TEXT,
  mensagem_final TEXT,
  erro           TEXT,
  total_count    BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
  WITH scoped AS (
    -- Verifies campaign ownership before exposing any item.
    SELECT c.id FROM wacrm.campaigns c
    JOIN wacrm.profiles p ON p.user_id = c.created_by
    WHERE c.id = p_campaign_id
      AND p.account_id = p_account_id
      AND is_account_member(p_account_id)
  )
  SELECT
    q.id,
    q.sent_at,
    q.created_at,
    ct.name,
    ct.phone,
    q.status,
    q.mensagem_final,
    q.erro,
    COUNT(*) OVER () AS total_count
  FROM wacrm.disp_message_queue q
  JOIN scoped s ON s.id = q.campaign_id
  LEFT JOIN wacrm.contacts ct ON ct.id = q.contact_id
  WHERE (p_status IS NULL OR q.status = p_status)
    AND (
      p_search IS NULL
      OR ct.name ILIKE '%' || p_search || '%'
      OR ct.phone ILIKE '%' || p_search || '%'
    )
  ORDER BY q.sent_at DESC NULLS LAST, q.created_at DESC
  LIMIT p_limit OFFSET p_offset;
$$;

ALTER FUNCTION wacrm.get_campaign_queue_items(UUID, UUID, TEXT, TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.get_campaign_queue_items(UUID, UUID, TEXT, TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION wacrm.get_campaign_queue_items(UUID, UUID, TEXT, TEXT, INT, INT) TO authenticated;
