-- ============================================================
-- 197_dispatch_import_jobs.sql   (PRD 11, A12/A13 — importação de contatos sem travar)
--
-- Problema (POST /api/disparador/contacts/import): com 100 mil linhas a importação depende de UMA sessão de navegador
-- aberta mandando ~10-100 blocos em sequência (fechar a aba no meio deixa a campanha com a lista pela metade); no caminho de
-- arquivo (FormData) o servidor lê e parseia a base inteira (até 20 MB) NO event loop, numa requisição só — CSV/XLSX grande
-- trava o processo e estoura o tempo do proxy; e cada bloco ainda precisa terminar dentro da requisição.
--
-- O que esta migration faz: JOB de importação retomável, no mesmo padrão do job de exportação (203).
--   wacrm.dispatch_import_jobs — um job por importação: conta, campanha/rascunho, mapeamento de colunas, blocos recebidos
--     (as LINHAS ficam no Storage, um objeto por bloco), próximo bloco, totais acumulados (importados/duplicados/inválidos/
--     blacklist/variáveis com falha), vinculados e ERROS POR LINHA/bloco (limitados).
--   wacrm.claim_dispatch_import_job(p_owner, p_lease_seconds) — reserva UM job (FOR UPDATE SKIP LOCKED): vários processos
--     de cron não pegam o mesmo job; lease vencido (processo caiu) volta à fila e continua do próximo bloco.
-- Um cron stateless (POST /api/disparador/imports/cron) processa os blocos em ordem, cada um pela MESMA função da rota
-- síncrona (importContactBlock) — dedupe, opt-out/blacklist, tags e vínculo idênticos. Nada de worker em memória.
-- RLS ligada SEM policy: só service_role (as rotas conferem a conta). anon/authenticated sem acesso.
--
-- COMPATIBILIDADE: sem a tabela (42P01/PGRST205) as rotas novas respondem 503 e a importação por blocos da rota atual continua
-- funcionando como sempre. Pode ser aplicada ANTES ou DEPOIS do deploy. Não precisa de 197b: os índices são em tabela nova e vazia.
--
-- PRÉ-CHECK (rodar antes):
--   SELECT to_regclass('wacrm.dispatch_import_jobs');                    -- NULL antes
--   SELECT to_regclass('wacrm.campaigns');                               -- não nulo
--   -- Storage: o bucket 'relatorio-exports' (migration 055) guarda os blocos sob '<account_id>/disparador-imports/…'.
-- ROLLBACK: DROP FUNCTION IF EXISTS wacrm.claim_dispatch_import_job(text, integer); DROP TABLE IF EXISTS wacrm.dispatch_import_jobs;
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.campaigns') IS NULL THEN
    RAISE EXCEPTION '197: falta wacrm.campaigns';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.dispatch_import_jobs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid        NOT NULL,
  requested_by     uuid,
  campaign_id      uuid,                                    -- edição de campanha existente (NULL = rascunho/standalone)
  draft_id         uuid,                                    -- criação de campanha nova (wizard)
  column_map       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  state            text        NOT NULL DEFAULT 'receiving'
                   CHECK (state IN ('receiving', 'pending', 'running', 'done', 'failed', 'cancelled')),
  blocks           jsonb       NOT NULL DEFAULT '{}'::jsonb, -- { "<n>": linhas_do_bloco } dos blocos já recebidos
  blocks_total     integer,                                 -- definido em /start; NULL enquanto recebe
  next_block       integer     NOT NULL DEFAULT 0,          -- primeiro bloco ainda não processado
  rows_total       integer     NOT NULL DEFAULT 0,
  rows_done        integer     NOT NULL DEFAULT 0,
  totals           jsonb       NOT NULL DEFAULT '{"importados":0,"duplicados":0,"invalidos":0,"blacklisted":0,"variaveis_falhas":0}'::jsonb,
  linked           integer     NOT NULL DEFAULT 0,
  errors           jsonb       NOT NULL DEFAULT '[]'::jsonb, -- até 200 mensagens (por linha/bloco)
  attempts         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until      timestamptz,
  owner_id         text,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at       timestamptz,
  finished_at      timestamptz,
  expires_at       timestamptz                              -- fim da guarda dos blocos no Storage
);

CREATE INDEX IF NOT EXISTS idx_dispatch_import_jobs_queue
  ON wacrm.dispatch_import_jobs (next_attempt_at) WHERE state IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_dispatch_import_jobs_account
  ON wacrm.dispatch_import_jobs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_import_jobs_stale
  ON wacrm.dispatch_import_jobs (created_at) WHERE state = 'receiving';

ALTER TABLE wacrm.dispatch_import_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.dispatch_import_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE wacrm.dispatch_import_jobs TO service_role;

-- Reserva UM job: pendente vencido ou em execução com lease vencido (processo caiu).
CREATE OR REPLACE FUNCTION wacrm.claim_dispatch_import_job(p_owner text, p_lease_seconds integer DEFAULT 120)
RETURNS SETOF wacrm.dispatch_import_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT j.id FROM wacrm.dispatch_import_jobs j
    WHERE (j.state = 'pending' AND j.next_attempt_at <= clock_timestamp())
       OR (j.state = 'running' AND j.lease_until < clock_timestamp())
    ORDER BY j.created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE wacrm.dispatch_import_jobs u
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

REVOKE ALL ON FUNCTION wacrm.claim_dispatch_import_job(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.claim_dispatch_import_job(text, integer) TO service_role;

-- Registro (migration 202). Tolerante a banco sem a 202.
DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('197_dispatch_import_jobs') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
