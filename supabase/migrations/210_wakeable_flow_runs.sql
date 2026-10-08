-- ============================================================
-- 210_wakeable_flow_runs.sql
--
-- Cron de fluxos (PRD 13 — IA-07/IA-08): acordar runs `delayed` (smart_delay) de forma ATÔMICA, em ORDEM e
-- sem reivindicar run inconsistente.
--
-- Problema (src/app/api/flows/cron/route.ts):
--  - o run era reivindicado (status → active) ANTES de conferir current_node_key/next_node_key; em dado
--    inconsistente o cron fazia `continue` e deixava o run `active`, preso, até o timeout de 24 h;
--  - `limit(20)` sem ORDER BY: com backlog, os runs mais antigos podiam ficar para trás (inanição);
--  - dois crons sobrepostos disputavam as mesmas linhas.
--
-- O que esta migration faz: wacrm.wakeable_flow_runs(p_limit) numa única transação:
--   1) seleciona runs `delayed` vencidos (wake_at <= agora) ORDER BY wake_at, id, FOR UPDATE SKIP LOCKED
--      (vários crons não colidem);
--   2) valida cada um contra flow_nodes: current_node_key preenchido, nó existente e next_node_key no config;
--   3) REIVINDICA (status 'active', wake_at NULL — exatamente o que o cron fazia) só os válidos e devolve
--      `run` (linha completa em jsonb) + `next_node_key`; os inválidos NÃO são tocados e voltam com `problem`
--      ('no_current_node' | 'node_missing' | 'no_next_node') para o app encerrá-los de forma controlada.
--
-- O app usa esta RPC só com FLOWS_CRON_V2 ligada (padrão desligada = caminho antigo). Sem a função
-- (PGRST202/42883) o app cai no caminho antigo. Pode ser aplicada antes OU depois do deploy.
--
-- PRÉ-CHECK (rodar antes):
--   SELECT to_regclass('wacrm.flow_runs'), to_regclass('wacrm.flow_nodes');            -- ambos não nulos
--   SELECT to_regprocedure('wacrm.wakeable_flow_runs(integer)');                        -- NULL antes
--   -- o índice de apoio é a 210b (arquivo próprio, CONCURRENTLY).
--
-- ROLLBACK: DROP FUNCTION IF EXISTS wacrm.wakeable_flow_runs(integer);   (e desligar FLOWS_CRON_V2)
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.flow_runs') IS NULL OR to_regclass('wacrm.flow_nodes') IS NULL THEN
    RAISE EXCEPTION '210: aplique as migrations de flows (010/058) antes';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.wakeable_flow_runs(p_limit integer DEFAULT 50)
RETURNS TABLE(run jsonb, next_node_key text, problem text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT r.id
    FROM wacrm.flow_runs r
    WHERE r.status = 'delayed'
      AND r.wake_at IS NOT NULL
      AND r.wake_at <= clock_timestamp()
    ORDER BY r.wake_at, r.id
    LIMIT LEAST(200, GREATEST(1, COALESCE(p_limit, 50)))
    FOR UPDATE OF r SKIP LOCKED
  ),
  checked AS (
    SELECT r.id,
           r.wake_at,
           n.config ->> 'next_node_key' AS nxt,
           CASE
             WHEN r.current_node_key IS NULL OR r.current_node_key = '' THEN 'no_current_node'
             WHEN n.flow_id IS NULL THEN 'node_missing'
             WHEN COALESCE(n.config ->> 'next_node_key', '') = '' THEN 'no_next_node'
           END AS problem
    FROM due d
    JOIN wacrm.flow_runs r ON r.id = d.id
    LEFT JOIN wacrm.flow_nodes n ON n.flow_id = r.flow_id AND n.node_key = r.current_node_key
  ),
  claimed AS (
    UPDATE wacrm.flow_runs r
    SET status = 'active', wake_at = NULL
    FROM checked c
    WHERE r.id = c.id AND c.problem IS NULL
    RETURNING r.*
  )
  SELECT s.run, s.next_node_key, s.problem
  FROM (
    SELECT to_jsonb(cl) AS run, c.nxt AS next_node_key, NULL::text AS problem, c.wake_at, cl.id
    FROM claimed cl JOIN checked c ON c.id = cl.id
    UNION ALL
    SELECT to_jsonb(r), NULL::text, c.problem, c.wake_at, r.id
    FROM checked c JOIN wacrm.flow_runs r ON r.id = c.id
    WHERE c.problem IS NOT NULL
  ) s
  ORDER BY s.wake_at, s.id;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.wakeable_flow_runs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.wakeable_flow_runs(integer) TO service_role;

-- Registro (202): tolera banco sem a 202 ainda; idempotente.
DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('210_wakeable_flow_runs') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
