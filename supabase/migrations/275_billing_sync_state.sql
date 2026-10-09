-- ============================================================
-- 275_billing_sync_state.sql   (PRD 17, PR 17.1 — régua de cobrança: estado da sincronização por fonte)
--
-- Uma linha por (conta, fonte): cursor da última sincronização (para a fonte A/C, delta, na PR 17.7), última execução e último erro
-- (alimenta o alerta "sync sem sucesso há > 1 h"). Para a fonte B o cursor fica vazio; só registramos execução e erro.
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.accounts');  -- não nulo
-- ROLLBACK:   BEGIN; DROP TABLE IF EXISTS wacrm.billing_sync_state; DELETE FROM wacrm.schema_migrations WHERE version = '275_billing_sync_state'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '275: falta wacrm.accounts — confira o schema vivo';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.billing_sync_state (
  account_id      uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (length(source) BETWEEN 1 AND 40),
  cursor          text,
  last_run_at     timestamptz,
  last_success_at timestamptz,
  last_error      text CHECK (last_error IS NULL OR length(last_error) <= 300),    -- curto, sem PII
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, source)
);

ALTER TABLE wacrm.billing_sync_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.billing_sync_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.billing_sync_state TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('275_billing_sync_state') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
