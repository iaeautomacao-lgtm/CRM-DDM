-- Aplicar manualmente após as migrations 143 e 157, ANTES do deploy.
BEGIN;

CREATE OR REPLACE FUNCTION wacrm.report_tabulacoes(
  p_account_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_team_id uuid DEFAULT NULL,
  p_agent_id uuid DEFAULT NULL
)
RETURNS TABLE (
  codigo_tabulacao integer,
  nome text,
  total bigint,
  human bigint,
  ai_auto bigint,
  automation bigint,
  com_sugestao bigint,
  aceitas bigint,
  trocadas bigint
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  WITH encerradas AS (
    SELECT c.outcome_source, c.outcome_tag_id, c.suggested_outcome_tag_id,
      CASE WHEN t.id IS NULL OR t.codigo_tabulacao = 16 THEN 16 ELSE t.codigo_tabulacao END AS codigo,
      CASE WHEN t.id IS NULL OR t.codigo_tabulacao = 16 THEN 'Sem tabulação' ELSE t.name END AS tabulacao
    FROM wacrm.conversations c
    LEFT JOIN wacrm.tags t ON t.id = c.outcome_tag_id
      AND t.account_id = p_account_id AND t.kind = 'outcome'
    WHERE c.account_id = p_account_id
      AND wacrm.is_account_member(p_account_id)
      AND wacrm.report_sees_conversation(c.team_id, c.assigned_agent_id)
      AND c.status = 'closed'
      AND c.closed_at >= p_from AND c.closed_at <= p_to
      AND (p_team_id IS NULL OR c.team_id = p_team_id)
      AND (p_agent_id IS NULL OR c.assigned_agent_id = p_agent_id)
  ), agrupadas AS (
    SELECT codigo, tabulacao,
      count(*) AS total,
      count(*) FILTER (WHERE outcome_source = 'human') AS human,
      count(*) FILTER (WHERE outcome_source = 'ai_auto') AS ai_auto,
      count(*) FILTER (WHERE outcome_source = 'automation') AS automation,
      count(*) FILTER (WHERE suggested_outcome_tag_id IS NOT NULL) AS com_sugestao,
      count(*) FILTER (WHERE outcome_source = 'human'
        AND outcome_tag_id = suggested_outcome_tag_id) AS aceitas,
      count(*) FILTER (WHERE outcome_source = 'human'
        AND suggested_outcome_tag_id IS NOT NULL
        AND outcome_tag_id IS DISTINCT FROM suggested_outcome_tag_id) AS trocadas
    FROM encerradas GROUP BY codigo, tabulacao
  )
  SELECT * FROM agrupadas
  UNION ALL
  SELECT 16, 'Sem tabulação', 0, 0, 0, 0, 0, 0, 0
  WHERE wacrm.is_account_member(p_account_id)
    AND NOT EXISTS (SELECT 1 FROM agrupadas WHERE codigo = 16)
  ORDER BY 3 DESC, 2;
$$;

ALTER FUNCTION wacrm.report_tabulacoes(uuid, timestamptz, timestamptz, uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION wacrm.report_tabulacoes(uuid, timestamptz, timestamptz, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.report_tabulacoes(uuid, timestamptz, timestamptz, uuid, uuid) TO authenticated;

COMMIT;
NOTIFY pgrst, 'reload schema';
