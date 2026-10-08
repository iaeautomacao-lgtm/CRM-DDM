-- 210b — índice de apoio do cron de fluxos (wakeable_flow_runs, migration 210).
-- ARQUIVO PRÓPRIO, SEM TRANSAÇÃO: CREATE INDEX CONCURRENTLY não roda dentro de BEGIN/COMMIT.
--
-- Normalmente este índice JÁ EXISTE: a migration 058 criou `flow_runs_delayed_wake` com exatamente esta
-- definição. Esta migration mantém o mesmo nome e predicado para que, onde ele falte (produção pode divergir
-- dos arquivos — confira antes), seja criado sem travar escritas; onde existe, é no-op.
--
-- PRÉ-CHECK: SELECT indexdef FROM pg_indexes WHERE schemaname='wacrm' AND indexname='flow_runs_delayed_wake';
-- ROLLBACK:  DROP INDEX CONCURRENTLY IF EXISTS wacrm.flow_runs_delayed_wake;   -- só se ele foi criado por aqui
CREATE INDEX CONCURRENTLY IF NOT EXISTS flow_runs_delayed_wake
  ON wacrm.flow_runs (wake_at)
  WHERE status = 'delayed' AND wake_at IS NOT NULL;
