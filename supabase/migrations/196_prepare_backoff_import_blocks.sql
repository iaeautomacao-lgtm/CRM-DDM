-- ============================================================
-- 196_prepare_backoff_import_blocks.sql   (PRD 11 — A3 backoff da preparação + gravação atômica dos blocos da importação)
--
-- (1) A3 — campanha agendada cuja preparação falha por erro transitório voltava a 'agendado' e era retentada TODO minuto (apaga a fila,
--     relê o público) — carga inútil no banco justamente quando ele está mal. Colunas novas em campaigns:
--       prepare_attempts integer NOT NULL DEFAULT 0   — falhas seguidas da preparação (zera no sucesso);
--       next_prepare_at  timestamptz                  — só volta a tentar quando chegar (backoff 1, 2, 4, 8, 16, 30 min; teto 30).
--     O app grava o motivo em campaigns.motivo_falha_inicio (migration 160) e alerta no Monitor na 5ª falha seguida.
--
-- (2) Importação em segundo plano (migration 197): PUT /api/disparador/imports/[id]/blocks/[n] fazia ler-modificar-gravar de
--     job.blocks; dois PUTs simultâneos perdiam um contador (o `start` acusava blocks_missing). A RPC
--     wacrm.dispatch_import_set_block(job, n, linhas) atualiza `blocks` e `rows_total` NUMA instrução (jsonb_set no UPDATE): o lock de
--     linha serializa PUTs concorrentes e nenhum contador se perde. A função não depende da tabela existir na criação (a 197 pode
--     ser aplicada antes ou depois): se a tabela não existir na hora da chamada, o app cai no caminho antigo.
--
-- COMPATIBILIDADE: o app detecta a ausência das colunas (42703/PGRST204) e da função (PGRST202/42883) e segue como antes.
-- Pode ser aplicada ANTES ou DEPOIS do deploy. Sem índice novo (a consulta das campanhas vencidas já filtra por status/agendamento).
--
-- PRÉ-CHECK (rodar antes):
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='wacrm' AND table_name='campaigns' AND column_name IN ('prepare_attempts','next_prepare_at');   -- 0 linhas
--   SELECT to_regprocedure('wacrm.dispatch_import_set_block(uuid,integer,integer)');                                      -- NULL
-- ROLLBACK: ALTER TABLE wacrm.campaigns DROP COLUMN IF EXISTS prepare_attempts, DROP COLUMN IF EXISTS next_prepare_at;
--           DROP FUNCTION IF EXISTS wacrm.dispatch_import_set_block(uuid, integer, integer);
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.campaigns') IS NULL THEN
    RAISE EXCEPTION '196: falta wacrm.campaigns';
  END IF;
END $$;

ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS prepare_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_prepare_at timestamptz;

COMMENT ON COLUMN wacrm.campaigns.prepare_attempts IS
  'Falhas seguidas da preparação (startCampaign) de campanha agendada; zera no sucesso. Backoff: next_prepare_at.';
COMMENT ON COLUMN wacrm.campaigns.next_prepare_at IS
  'Campanha agendada em backoff só é preparada de novo a partir deste horário (NULL = sem espera).';

-- Gravação ATÔMICA de um bloco recebido da importação (migration 197). Devolve a linha atualizada (jsonb) ou NULL se o job não
-- existe ou não está mais recebendo blocos.
CREATE OR REPLACE FUNCTION wacrm.dispatch_import_set_block(p_job_id uuid, p_n integer, p_rows integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row jsonb;
BEGIN
  UPDATE wacrm.dispatch_import_jobs j
  SET blocks = jsonb_set(j.blocks, ARRAY[p_n::text], to_jsonb(p_rows), true),
      rows_total = COALESCE((
        SELECT sum(e.value::integer)
        FROM jsonb_each_text(jsonb_set(j.blocks, ARRAY[p_n::text], to_jsonb(p_rows), true)) e
      ), 0)
  WHERE j.id = p_job_id AND j.state = 'receiving'
  RETURNING to_jsonb(j) INTO v_row;
  RETURN v_row;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.dispatch_import_set_block(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.dispatch_import_set_block(uuid, integer, integer) TO service_role;

-- Registro (migration 202). Tolerante a banco sem a 202.
DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('196_prepare_backoff_import_blocks') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
