-- ============================================================
-- 203_dispatch_export_jobs.sql   (PRD 11, A22 — exportação assíncrona da fila do Disparador)
--
-- Problema: GET /api/disparador/campaigns/[id]/queue-details?export=xlsx lia até 100.000 linhas da fila DENTRO da requisição
-- (100 páginas em OFFSET) e montava o XLSX em memória — derruba o pooler e o processo do Passenger.
--
-- O que esta migration faz: tabela de JOBS + RPC de reserva.
--   wacrm.dispatch_export_jobs — um job por pedido de exportação (conta, campanha, métrica, estado, progresso, cursor de
--     leitura por id, arquivo no Storage, expiração). Um cron stateless (POST /api/disparador/exports/cron) processa em
--     BLOCOS retomáveis (o cursor fica no banco: restart/deploy no meio só continua), grava partes no Storage, monta o
--     arquivo final e o link de download expira (expires_at; o cron apaga o arquivo e marca 'expired').
--   wacrm.claim_dispatch_export_job(p_owner, p_lease_seconds) — reserva UM job (FOR UPDATE SKIP LOCKED): vários processos
--     de cron não pegam o mesmo job; lease vencido (processo caiu) volta à fila.
-- RLS ligada SEM policy: só service_role (as rotas conferem a conta). anon/authenticated sem acesso.
-- Nada de worker em memória: todo o estado está nesta tabela.
--
-- COMPATIBILIDADE: sem a tabela (42P01/PGRST205) as rotas novas respondem 503 com mensagem clara e a exportação síncrona
-- pequena continua funcionando. Pode ser aplicada ANTES ou DEPOIS do deploy. Não precisa de 203b: os índices são em tabela nova e vazia.
--
-- PRÉ-CHECK (rodar antes):
--   SELECT to_regclass('wacrm.dispatch_export_jobs');                       -- NULL antes
--   SELECT to_regclass('wacrm.campaigns'), to_regclass('wacrm.accounts');   -- não nulos
--   -- Storage: o bucket 'relatorio-exports' (migration 055) guarda os arquivos sob '<account_id>/…'.
-- ROLLBACK: DROP FUNCTION IF EXISTS wacrm.claim_dispatch_export_job(text, integer); DROP TABLE IF EXISTS wacrm.dispatch_export_jobs;
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.campaigns') IS NULL THEN
    RAISE EXCEPTION '203: falta wacrm.campaigns';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.dispatch_export_jobs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid        NOT NULL,
  campaign_id   uuid        NOT NULL REFERENCES wacrm.campaigns(id) ON DELETE CASCADE,
  requested_by  uuid,
  status_key    text        NOT NULL,                       -- métrica do modal (enviado, erro, total…)
  format        text        NOT NULL DEFAULT 'csv' CHECK (format IN ('csv')),
  state         text        NOT NULL DEFAULT 'pending'
                CHECK (state IN ('pending', 'running', 'done', 'failed', 'expired', 'cancelled')),
  rows_done     integer     NOT NULL DEFAULT 0,
  total_rows    integer,                                    -- estimativa no pedido (agregação por status); NULL = desconhecido
  parts_count   integer     NOT NULL DEFAULT 0,
  cursor_id     uuid,                                       -- última linha lida (keyset por id)
  truncated     boolean     NOT NULL DEFAULT false,         -- bateu no teto de linhas do job
  file_path     text,
  file_size     bigint,
  attempts      integer     NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until   timestamptz,
  owner_id      text,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at    timestamptz,
  finished_at   timestamptz,
  expires_at    timestamptz                                 -- fim da validade do arquivo/link (definido ao concluir)
);

-- Fila do cron (pendentes/rodando) e listagem por conta.
CREATE INDEX IF NOT EXISTS idx_dispatch_export_jobs_queue
  ON wacrm.dispatch_export_jobs (next_attempt_at) WHERE state IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_dispatch_export_jobs_account
  ON wacrm.dispatch_export_jobs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_export_jobs_expiry
  ON wacrm.dispatch_export_jobs (expires_at) WHERE state = 'done';

ALTER TABLE wacrm.dispatch_export_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.dispatch_export_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE wacrm.dispatch_export_jobs TO service_role;

-- Reserva UM job: pendente vencido ou em execução com lease vencido (processo caiu).
CREATE OR REPLACE FUNCTION wacrm.claim_dispatch_export_job(p_owner text, p_lease_seconds integer DEFAULT 120)
RETURNS SETOF wacrm.dispatch_export_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT j.id FROM wacrm.dispatch_export_jobs j
    WHERE (j.state = 'pending' AND j.next_attempt_at <= clock_timestamp())
       OR (j.state = 'running' AND j.lease_until < clock_timestamp())
    ORDER BY j.created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE wacrm.dispatch_export_jobs u
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

REVOKE ALL ON FUNCTION wacrm.claim_dispatch_export_job(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.claim_dispatch_export_job(text, integer) TO service_role;

-- Registro (migration 202). Tolerante a banco sem a 202.
DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('203_dispatch_export_jobs') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
