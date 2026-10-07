-- ============================================================
-- 179_flow_run_agent_bindings.sql
--
-- Snapshot de agente POR RUN (Fase 4 — runtime).
--
-- Ao iniciar um run, o engine fixa a versão publicada (agent_version_id) de
-- TODOS os nós ai_agent do fluxo que têm `agent_id` (config do nó). Editar o
-- agente depois publica uma versão nova que só vale para conversas NOVAS; o run
-- em andamento continua na versão fixada (e o rollback também só vale para
-- runs novos). Sem segredo e sem URL resolvida aqui: só ids e o hash da versão.
--
--  - PK (run_id, node_key): um agente fixado por nó do run (idempotente).
--  - FK composta (account_id, agent_id, agent_version_id) → ai_agent_versions
--    (a 177 tem UNIQUE (account_id, agent_id, id)): a versão tem de ser do
--    agente E da conta; versão imutável (trigger da 177), então o snapshot é
--    reproduzível.
--  - ON DELETE CASCADE no run: apagar o run apaga o snapshot.
--
-- Acesso: RLS ligada, sem policy, REVOKE de anon/authenticated (como a 175/176).
--
-- PRÉ-CHECK (rodar antes):
--   SELECT to_regclass('wacrm.flow_runs'), to_regclass('wacrm.ai_agent_versions');  -- ambos NÃO nulos (177)
--   SELECT to_regclass('wacrm.flow_run_agent_bindings');                           -- NULL antes
--
-- ORDEM: aplicar ANTES do deploy do código. Sem a tabela o engine segue sem
-- snapshot (usa a versão publicada na hora e registra o aviso) — não derruba
-- o atendimento. Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.flow_runs') IS NULL OR to_regclass('wacrm.ai_agent_versions') IS NULL THEN
    RAISE EXCEPTION '179: aplique a 177 (ai_agent_versions) e confira wacrm.flow_runs';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.flow_run_agent_bindings (
  run_id            uuid NOT NULL REFERENCES wacrm.flow_runs(id) ON DELETE CASCADE,
  account_id        uuid NOT NULL,
  flow_id           uuid NOT NULL,
  node_key          text NOT NULL,
  agent_id          uuid NOT NULL,
  agent_version_id  uuid NOT NULL,
  config_hash       text NOT NULL CHECK (config_hash ~ '^[a-f0-9]{64}$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, node_key),
  FOREIGN KEY (account_id, agent_id, agent_version_id)
    REFERENCES wacrm.ai_agent_versions (account_id, agent_id, id)
);

CREATE INDEX IF NOT EXISTS idx_flow_run_agent_bindings_agent
  ON wacrm.flow_run_agent_bindings (account_id, agent_id);

ALTER TABLE wacrm.flow_run_agent_bindings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.flow_run_agent_bindings FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.flow_run_agent_bindings TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
