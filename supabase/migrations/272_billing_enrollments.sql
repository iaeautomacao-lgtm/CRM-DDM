-- ============================================================
-- 272_billing_enrollments.sql   (PRD 17, PR 17.1 — régua de cobrança: inscrição da dívida na régua)
--
-- Uma inscrição = (régua, dívida). Guarda o estado (ativa/pausada/parada/concluída), o MOTIVO da parada (enum fechado) e
-- `next_step_at` (quando a próxima etapa fica devida) — o índice parcial em `next_step_at WHERE status='active'` é o que mantém o tick
-- barato com centenas de milhares de inscrições. Parada nunca é apagada: fica o histórico (por que paramos de cobrar).
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.billing_rulers'), to_regclass('wacrm.billing_debts');  -- não nulos (270, 271)
-- ROLLBACK:   BEGIN; DROP TABLE IF EXISTS wacrm.billing_enrollments; DELETE FROM wacrm.schema_migrations WHERE version = '272_billing_enrollments'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.billing_rulers') IS NULL OR to_regclass('wacrm.billing_debts') IS NULL THEN
    RAISE EXCEPTION '272: faltam wacrm.billing_rulers/billing_debts (migrations 270 e 271)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.billing_enrollments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  ruler_id     uuid NOT NULL REFERENCES wacrm.billing_rulers(id) ON DELETE CASCADE,
  debt_id      uuid NOT NULL REFERENCES wacrm.billing_debts(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped', 'completed')),
  stop_reason  text CHECK (stop_reason IN ('paid', 'agreement', 'opt_out', 'blacklist', 'cancelled', 'contact_removed', 'ruler_disabled', 'manual')),
  stopped_at   timestamptz,
  next_step_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_billing_enrollment_ruler_debt UNIQUE (ruler_id, debt_id),
  CONSTRAINT billing_enrollment_stop_fields CHECK (
    (status = 'stopped' AND stop_reason IS NOT NULL AND stopped_at IS NOT NULL)
    OR (status <> 'stopped' AND stop_reason IS NULL AND stopped_at IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_billing_enrollments_due ON wacrm.billing_enrollments (next_step_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_billing_enrollments_debt ON wacrm.billing_enrollments (debt_id);
CREATE INDEX IF NOT EXISTS idx_billing_enrollments_account_status ON wacrm.billing_enrollments (account_id, status);

ALTER TABLE wacrm.billing_enrollments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.billing_enrollments FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.billing_enrollments TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('272_billing_enrollments') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
