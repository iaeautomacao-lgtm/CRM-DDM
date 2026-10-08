-- 212: flow_run_tool_results — resultado BRUTO das tools da IA, FORA de flow_run_events (PRD 13, IA-11).
-- NÃO usa CREATE INDEX CONCURRENTLY (índice só em tabela nova e vazia): aplicar normalmente, uma vez.
--
-- Problema: tool_result gravava até 8.000 caracteres do corpo bruto da DDM (CPF, nomes, valores) em
-- flow_run_events.payload.result, que aparece na API/export de runs, no histórico da tela e nas métricas. Mas o PRÓPRIO
-- MOTOR relê esse texto: herdar_contexto_anterior (prompt do próximo nó de IA) e canonicalizeAgreementArgsFromRun
-- (iddev/sistema do localizar_devedor para efetiva_acordo). Reduzir o evento sem guardar o bruto em outro lugar mudaria
-- o que a IA recebe.
--
-- O que esta migration faz: guarda o bruto numa tabela FECHADA (RLS ligada SEM policy; anon/authenticated sem acesso;
-- só service_role — o motor). Ela não é lida por nenhuma API/export/tela de runs. O evento passa a trazer só resumo
-- (status, tamanho, formato, chaves de primeiro nível e a mensagem de falha). O motor lê daqui com fallback ao payload
-- antigo (eventos gravados antes desta migration continuam funcionando).
--
-- COMPATIBILIDADE: sem a tabela (42P01/PGRST205) o motor grava o resultado como antes (payload.result). Pode ser aplicada
-- antes OU depois do deploy.
--
-- PRÉ-CHECK:
--   SELECT to_regclass('wacrm.flow_runs');                  -- não nulo
--   SELECT to_regclass('wacrm.flow_run_tool_results');      -- NULL antes
-- ROLLBACK: DROP TABLE IF EXISTS wacrm.flow_run_tool_results;   (o motor volta a gravar no payload)
--
-- Retenção: a linha some junto com o run (ON DELETE CASCADE). Idempotente.

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.flow_runs') IS NULL THEN
    RAISE EXCEPTION '212: wacrm.flow_runs ausente (aplique a 010 antes)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.flow_run_tool_results (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flow_run_id uuid        NOT NULL REFERENCES wacrm.flow_runs(id) ON DELETE CASCADE,
  account_id  uuid        NOT NULL,
  node_key    text,
  tool_name   text        NOT NULL,
  result      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_flow_run_tool_results_run
  ON wacrm.flow_run_tool_results (flow_run_id, created_at, id);

-- Tabela fechada: RLS ligada e NENHUMA policy; só service_role.
ALTER TABLE wacrm.flow_run_tool_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.flow_run_tool_results FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE wacrm.flow_run_tool_results TO service_role;
GRANT USAGE, SELECT ON SEQUENCE wacrm.flow_run_tool_results_id_seq TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
