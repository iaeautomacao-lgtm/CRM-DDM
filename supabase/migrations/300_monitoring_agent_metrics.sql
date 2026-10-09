-- ============================================================
-- 300_monitoring_agent_metrics.sql   (TASK1 item 2 — Monitoramento: métricas por agente)
--
-- wacrm.monitoring_agent_metrics(p_from, p_to) → uma linha por atendente com atividade no período:
--   agent_id                    uuid
--   first_response_count        bigint   conversas com 1ª resposta humana (first_response_at) dentro do período
--   first_response_avg_seconds  numeric  média de (first_response_at − created_at), em segundos, nunca negativa
--   resolved_count              bigint   conversas encerradas (closed_at) dentro do período
-- Mesmas definições de src/lib/monitoramento/day-view.ts ("atendidas" e "finalizadas"), atribuídas ao atendente atual da conversa
-- (assigned_agent_id). Conversas sem atendente ficam de fora. Agregação toda no banco: nenhuma linha vai para o Node.
-- SECURITY INVOKER: a RLS de conversations vale como na leitura direta (supervisor vê só as equipes dele); o filtro por conta
-- (wacrm.current_account_id()) ajuda o planejador. Índices que servem: idx_conversations_account_first_response e
-- idx_conversations_account_closed_at (migration 130) — não precisa de índice novo.
-- p_from inclusivo, p_to exclusivo; janela máxima de 92 dias (acima disso, erro).
--
-- PRÉ-CHECK:  SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--              WHERE n.nspname='wacrm' AND p.proname='monitoring_agent_metrics';   -- 0 linhas
-- ROLLBACK:   DROP FUNCTION IF EXISTS wacrm.monitoring_agent_metrics(timestamptz, timestamptz);
--             DELETE FROM wacrm.schema_migrations WHERE version = '300_monitoring_agent_metrics';
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.conversations') IS NULL THEN
    RAISE EXCEPTION '300: falta wacrm.conversations';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'wacrm' AND p.proname = 'current_account_id') THEN
    RAISE EXCEPTION '300: wacrm.current_account_id() não existe (migration 170)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.monitoring_agent_metrics(p_from timestamptz, p_to timestamptz)
RETURNS TABLE (agent_id uuid, first_response_count bigint, first_response_avg_seconds numeric, resolved_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'período inválido' USING ERRCODE = '22023';
  END IF;
  IF p_to - p_from > interval '92 days' THEN
    RAISE EXCEPTION 'período máximo de 92 dias' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  WITH fr AS (
    SELECT c.assigned_agent_id AS aid,
           count(*) AS n,
           avg(GREATEST(0, EXTRACT(EPOCH FROM (c.first_response_at - c.created_at)))) AS avg_s
      FROM wacrm.conversations c
     WHERE c.account_id = wacrm.current_account_id()
       AND c.assigned_agent_id IS NOT NULL
       AND c.first_response_at >= p_from AND c.first_response_at < p_to
     GROUP BY c.assigned_agent_id
  ), rs AS (
    SELECT c.assigned_agent_id AS aid, count(*) AS n
      FROM wacrm.conversations c
     WHERE c.account_id = wacrm.current_account_id()
       AND c.assigned_agent_id IS NOT NULL
       AND c.closed_at >= p_from AND c.closed_at < p_to
     GROUP BY c.assigned_agent_id
  )
  SELECT COALESCE(fr.aid, rs.aid),
         COALESCE(fr.n, 0)::bigint,
         round(fr.avg_s::numeric, 1),
         COALESCE(rs.n, 0)::bigint
    FROM fr FULL JOIN rs ON rs.aid = fr.aid
   ORDER BY COALESCE(rs.n, 0) DESC, COALESCE(fr.n, 0) DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION wacrm.monitoring_agent_metrics(timestamptz, timestamptz) TO authenticated;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('300_monitoring_agent_metrics') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
