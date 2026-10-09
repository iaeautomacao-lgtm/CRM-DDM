-- ============================================================
-- 334_cron_heartbeat.sql   (AUDIT-DISPARADOR D-12 — saúde de TODOS os crons, não só do cron_tick do disparador)
--
-- Hoje só o tick do disparador deixa rastro (system_logs/cron_tick). Prepare, health, exportações, importações, webhooks de saída,
-- billing, automações, flows, renovação de tokens e redistribuição de conversas podem parar (o agendador externo cai, o segredo muda)
-- sem ninguém ver: o sintoma aparece dias depois.
--
--   wacrm.cron_heartbeat — UMA linha por job: cadência esperada, último início, último OK, último status/erro, duração, contadores.
--   wacrm.cron_heartbeat_record(job, cadência, status, duração, erro) — upsert numa única ida; chamada pelo fim de cada rota de cron.
-- RLS ligada SEM policy: só service_role (o cartão de saúde lê pelo servidor, sem dado de cliente: só nome do job, horários e contagens).
--
-- COMPATIBILIDADE: sem a tabela/função o app segue igual (o registro do batimento é best-effort e nunca derruba o cron) e o cartão de
-- saúde mostra só o cron_tick como antes. Pode ser aplicada antes ou depois do deploy.
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.cron_heartbeat');   -- NULL antes
-- ROLLBACK:   DROP FUNCTION IF EXISTS wacrm.cron_heartbeat_record(text, integer, text, integer, text); DROP TABLE IF EXISTS wacrm.cron_heartbeat;
-- Idempotente.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS wacrm.cron_heartbeat (
  job                    text PRIMARY KEY CHECK (job ~ '^[a-z0-9_.:-]{1,64}$'),
  expected_every_seconds integer NOT NULL CHECK (expected_every_seconds BETWEEN 10 AND 604800),
  last_started_at        timestamptz,
  last_ok_at             timestamptz,
  last_status            text NOT NULL CHECK (last_status IN ('ok', 'error')),
  last_error             text,
  last_duration_ms       integer,
  runs                   bigint NOT NULL DEFAULT 0,
  failures               bigint NOT NULL DEFAULT 0,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE wacrm.cron_heartbeat ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.cron_heartbeat FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.cron_heartbeat TO service_role;

CREATE OR REPLACE FUNCTION wacrm.cron_heartbeat_record(
  p_job text,
  p_expected_every_seconds integer,
  p_status text,
  p_duration_ms integer DEFAULT NULL,
  p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ok boolean := p_status = 'ok';
  v_dur integer := GREATEST(COALESCE(p_duration_ms, 0), 0);
BEGIN
  IF p_job IS NULL OR p_job !~ '^[a-z0-9_.:-]{1,64}$' OR p_status NOT IN ('ok', 'error') THEN
    RETURN;
  END IF;
  INSERT INTO wacrm.cron_heartbeat AS h
    (job, expected_every_seconds, last_started_at, last_ok_at, last_status, last_error, last_duration_ms, runs, failures, updated_at)
  VALUES
    (p_job, GREATEST(10, LEAST(COALESCE(p_expected_every_seconds, 60), 604800)),
     now() - pg_catalog.make_interval(secs => v_dur / 1000.0),
     CASE WHEN v_ok THEN now() END, p_status, CASE WHEN v_ok THEN NULL ELSE pg_catalog.left(p_error, 500) END, v_dur, 1,
     CASE WHEN v_ok THEN 0 ELSE 1 END, now())
  ON CONFLICT (job) DO UPDATE SET
    expected_every_seconds = EXCLUDED.expected_every_seconds,
    last_started_at = EXCLUDED.last_started_at,
    last_ok_at = COALESCE(EXCLUDED.last_ok_at, h.last_ok_at),
    last_status = EXCLUDED.last_status,
    last_error = EXCLUDED.last_error,
    last_duration_ms = EXCLUDED.last_duration_ms,
    runs = h.runs + 1,
    failures = h.failures + (CASE WHEN v_ok THEN 0 ELSE 1 END),
    updated_at = now();
END;
$$;

REVOKE ALL ON FUNCTION wacrm.cron_heartbeat_record(text, integer, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.cron_heartbeat_record(text, integer, text, integer, text) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('334_cron_heartbeat') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
