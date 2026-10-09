-- ============================================================
-- 317_automation_pending_lease.sql   (auditoria de backend B-07 — lease do cron de automações)
--
-- PROBLEMA: /api/automations/cron marcava a linha de automation_pending_executions como 'running' e só o fim da execução
--   (markPending) a fechava. Um restart do Passenger no meio deixava a linha 'running' PARA SEMPRE: a automação daquele
--   contato nunca terminava e ninguém ficava sabendo.
-- O QUE FAZ:
--   1. Colunas lease_until, attempts, started_at e error_message.
--   2. wacrm.claim_automation_pending(p_lease_seconds): numa transação,
--      a) REAPER: linha 'running' com lease vencido (ou, de antes desta migration, sem lease e com run_at > 1 h atrás)
--         vira 'failed' com motivo; o log da automação (se houver) vira 'partial' com a mesma explicação. NÃO é retomada:
--         a execução pode ter enviado parte das mensagens e retomar repetiria envios ("não roda duas vezes");
--      b) CLAIM de UMA linha vencida ('pending', run_at <= now()), FOR UPDATE SKIP LOCKED: duas execuções sobrepostas do
--         cron nunca pegam a mesma linha. Marca 'running', lease_until = now() + lease, attempts + 1, started_at.
--      Devolve a linha reivindicada (ou nenhuma) e quantas o reaper fechou.
--   3. wacrm.finish_automation_pending(id, status, motivo): fecha só se ainda estiver 'running' (o reaper não é desfeito
--      por uma execução que voltou depois do lease) e limpa o lease. Devolve true se fechou.
--   Tudo SECURITY DEFINER, search_path vazio, só service_role (a tabela não tem policy para usuários, 006).
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.automation_pending_executions'), to_regclass('wacrm.automation_logs');   -- não nulos
--   SELECT count(*) FROM wacrm.automation_pending_executions WHERE status = 'running';
--     -- linhas presas hoje: na 1ª chamada do cron depois do deploy, as com run_at > 1 h atrás viram 'failed' (motivo gravado)
-- VERIFICAÇÃO:
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'wacrm'
--      AND table_name = 'automation_pending_executions' AND column_name IN ('lease_until','attempts','started_at','error_message');  -- 4
--   SELECT version FROM wacrm.schema_migrations WHERE version = '317_automation_pending_lease';
-- ORDEM: antes do deploy (o cron novo usa as funções; sem elas cai no caminho antigo). Idempotente.
-- ROLLBACK:
--   BEGIN;
--   DROP FUNCTION IF EXISTS wacrm.claim_automation_pending(integer), wacrm.finish_automation_pending(uuid, text, text);
--   DROP INDEX IF EXISTS wacrm.idx_automation_pending_running_lease;
--   ALTER TABLE wacrm.automation_pending_executions DROP COLUMN IF EXISTS lease_until, DROP COLUMN IF EXISTS attempts,
--     DROP COLUMN IF EXISTS started_at, DROP COLUMN IF EXISTS error_message;
--   DELETE FROM wacrm.schema_migrations WHERE version = '317_automation_pending_lease';
--   COMMIT;   (antes: reverter o deploy do cron)
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.automation_pending_executions') IS NULL OR to_regclass('wacrm.automation_logs') IS NULL THEN
    RAISE EXCEPTION '317: faltam wacrm.automation_pending_executions / automation_logs (migration 006)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'wacrm' AND table_name = 'automation_pending_executions' AND column_name = 'status'
  ) THEN
    RAISE EXCEPTION '317: automation_pending_executions sem a coluna status — confira o schema vivo';
  END IF;
END $$;

ALTER TABLE wacrm.automation_pending_executions
  ADD COLUMN IF NOT EXISTS lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS error_message text;

-- Reaper só olha 'running' (poucas linhas): índice parcial pequeno.
CREATE INDEX IF NOT EXISTS idx_automation_pending_running_lease
  ON wacrm.automation_pending_executions (lease_until) WHERE status = 'running';

CREATE OR REPLACE FUNCTION wacrm.claim_automation_pending(p_lease_seconds integer DEFAULT 300)
RETURNS TABLE (claimed jsonb, reaped integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_msg constant text :=
    'Execução interrompida (reinício do servidor ou tempo esgotado). Não foi retomada para não repetir envios.';
  v_reaped integer := 0;
  v_row wacrm.automation_pending_executions;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'lease inválido (30 a 3600 s)' USING ERRCODE = '22023';
  END IF;

  -- a) reaper
  WITH dead AS (
    UPDATE wacrm.automation_pending_executions p
       SET status = 'failed', lease_until = NULL, error_message = v_msg
     WHERE p.status = 'running'
       AND (p.lease_until < now() OR (p.lease_until IS NULL AND p.run_at < now() - interval '1 hour'))
    RETURNING p.log_id
  ), logs AS (
    UPDATE wacrm.automation_logs l
       SET status = 'partial', error_message = v_msg
      FROM dead
     WHERE l.id = dead.log_id AND l.status <> 'failed'
    RETURNING l.id
  )
  SELECT count(*) INTO v_reaped FROM dead;

  -- b) claim de uma linha
  SELECT * INTO v_row
    FROM wacrm.automation_pending_executions p
   WHERE p.status = 'pending' AND p.run_at <= now()
   ORDER BY p.run_at
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF FOUND THEN
    UPDATE wacrm.automation_pending_executions p
       SET status = 'running',
           lease_until = now() + make_interval(secs => p_lease_seconds),
           attempts = p.attempts + 1,
           started_at = now(),
           error_message = NULL
     WHERE p.id = v_row.id
    RETURNING * INTO v_row;
    RETURN QUERY SELECT to_jsonb(v_row), v_reaped;
  ELSE
    RETURN QUERY SELECT NULL::jsonb, v_reaped;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.finish_automation_pending(p_id uuid, p_status text, p_error text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_status NOT IN ('done', 'failed') THEN
    RAISE EXCEPTION 'status inválido: %', p_status USING ERRCODE = '22023';
  END IF;
  UPDATE wacrm.automation_pending_executions p
     SET status = p_status, lease_until = NULL, error_message = left(p_error, 1000)
   WHERE p.id = p_id AND p.status = 'running';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.claim_automation_pending(integer), wacrm.finish_automation_pending(uuid, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.claim_automation_pending(integer), wacrm.finish_automation_pending(uuid, text, text)
  TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('317_automation_pending_lease') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
