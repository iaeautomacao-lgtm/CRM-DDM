-- ============================================================
-- 297_history_export_jobs.sql   (TASK36 item 2 — exportar o período do Histórico de conversas encerradas)
--
-- Mesma infraestrutura da exportação assíncrona do Disparador (migration 203): um JOB por pedido, processado em BLOCOS retomáveis
-- por um cron stateless (o mesmo POST /api/disparador/exports/cron), partes no Storage (bucket 'relatorio-exports', migration 055),
-- arquivo final CSV e, ao concluir, UMA LINHA em wacrm.export_history — o arquivo aparece na página Exportações e segue a política
-- dela (só exports.manage: admin e proprietário, migration 220).
--
--   wacrm.history_export_jobs — conta, período (closed_at), tabulação opcional (tags.id = conversations.outcome_tag_id), estado,
--     progresso, cursor por id (keyset), arquivo, tentativas, lease. RLS ligada SEM policy: só service_role (as rotas conferem
--     conta e exports.manage).
--   wacrm.claim_history_export_job(p_owner, p_lease_seconds) — reserva UM job (FOR UPDATE SKIP LOCKED); lease vencido volta à fila.
--
-- Índices: a tabela é nova e vazia (instantâneo, sem CONCURRENTLY). A leitura das conversas usa os índices de conversations já existentes
-- (conta + status/closed_at; idx_conversations_outcome_tag da 041).
--
-- COMPATIBILIDADE: sem a tabela as rotas respondem 503 com mensagem clara. Pode ser aplicada ANTES ou DEPOIS do deploy.
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.history_export_jobs');   -- NULL antes
--             SELECT to_regclass('wacrm.export_history'), to_regclass('wacrm.accounts');   -- não nulos
-- VERIFICAÇÃO: SELECT proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='wacrm' AND proname='claim_history_export_job';
-- ROLLBACK:   DROP FUNCTION IF EXISTS wacrm.claim_history_export_job(text, integer); DROP TABLE IF EXISTS wacrm.history_export_jobs;
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.export_history') IS NULL THEN
    RAISE EXCEPTION '297: falta wacrm.export_history (migration 055)';
  END IF;
  IF to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '297: falta wacrm.accounts';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.history_export_jobs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  requested_by    uuid,
  period_from     timestamptz NOT NULL,                       -- closed_at >= period_from
  period_to       timestamptz NOT NULL,                       -- closed_at <  period_to (o front manda o início do dia seguinte)
  tabulacao_id    uuid,                                       -- tags.id (conversations.outcome_tag_id); NULL = todas
  format          text        NOT NULL DEFAULT 'csv' CHECK (format IN ('csv')),
  state           text        NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  rows_done       integer     NOT NULL DEFAULT 0,
  total_rows      integer,                                    -- contagem no pedido; NULL = desconhecido
  parts_count     integer     NOT NULL DEFAULT 0,
  cursor_id       uuid,                                       -- última conversa lida (keyset por id)
  truncated       boolean     NOT NULL DEFAULT false,         -- bateu no teto de linhas do job
  file_path       text,
  file_size       bigint,
  export_history_id uuid,                                     -- linha criada em wacrm.export_history ao concluir
  attempts        integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until     timestamptz,
  owner_id        text,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at      timestamptz,
  finished_at     timestamptz,
  CHECK (period_to > period_from)
);

CREATE INDEX IF NOT EXISTS idx_history_export_jobs_queue
  ON wacrm.history_export_jobs (next_attempt_at) WHERE state IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_history_export_jobs_account
  ON wacrm.history_export_jobs (account_id, created_at DESC);

ALTER TABLE wacrm.history_export_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.history_export_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE wacrm.history_export_jobs TO service_role;

CREATE OR REPLACE FUNCTION wacrm.claim_history_export_job(p_owner text, p_lease_seconds integer DEFAULT 120)
RETURNS SETOF wacrm.history_export_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT j.id FROM wacrm.history_export_jobs j
    WHERE (j.state = 'pending' AND j.next_attempt_at <= clock_timestamp())
       OR (j.state = 'running' AND j.lease_until < clock_timestamp())
    ORDER BY j.created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE wacrm.history_export_jobs u
  SET state = 'running',
      owner_id = p_owner,
      lease_until = clock_timestamp() + pg_catalog.make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 120), 10)),
      started_at = COALESCE(u.started_at, clock_timestamp()),
      attempts = u.attempts + CASE WHEN u.state = 'running' THEN 1 ELSE 0 END
  FROM picked p
  WHERE u.id = p.id
  RETURNING u.*;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.claim_history_export_job(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.claim_history_export_job(text, integer) TO service_role;

DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('297_history_export_jobs') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
