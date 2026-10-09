-- ============================================================
-- 271_billing_debts.sql   (PRD 17, PR 17.1 — régua de cobrança: espelho das dívidas acompanhadas)
--
-- Fonte B (decisão do dono, 09/10): a carteira é importada COM o vencimento; antes de cada cobrança o motor consulta o CPF na API da DDM
-- e atualiza `status` (paga/acordo/cancelada) e `last_checked_at`. A fonte é plugável (`source`): começa só 'ddm'; Cobmais entra depois
-- sem refazer o motor.
-- SEM CPF aqui (LGPD/PII): o espelho guarda `contact_id` (o CPF vive em contacts.cpf) e a referência externa da dívida (iddev+sistema).
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.accounts'), to_regclass('wacrm.contacts');  -- não nulos · SELECT to_regclass('wacrm.billing_debts');  -- NULL
-- ROLLBACK:   BEGIN; DROP TABLE IF EXISTS wacrm.billing_debts; DELETE FROM wacrm.schema_migrations WHERE version = '271_billing_debts'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL OR to_regclass('wacrm.contacts') IS NULL THEN
    RAISE EXCEPTION '271: faltam wacrm.accounts/contacts — confira o schema vivo';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.billing_debts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  contact_id        uuid NOT NULL REFERENCES wacrm.contacts(id) ON DELETE CASCADE,
  source            text NOT NULL DEFAULT 'ddm' CHECK (length(source) BETWEEN 1 AND 40),
  external_ref      text NOT NULL CHECK (length(external_ref) BETWEEN 1 AND 200),     -- ex.: "<iddev>:<sistema>"
  due_date          date NOT NULL,                                                    -- vencimento (data civil, sem hora)
  amount_cents      bigint CHECK (amount_cents IS NULL OR amount_cents >= 0),
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'agreement', 'cancelled')),
  source_updated_at timestamptz,
  last_checked_at   timestamptz,                                                      -- última consulta pontual à fonte (antes de cobrar)
  synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_billing_debts_source_ref UNIQUE (account_id, source, external_ref)
);
CREATE INDEX IF NOT EXISTS idx_billing_debts_due_open ON wacrm.billing_debts (account_id, due_date) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_billing_debts_contact ON wacrm.billing_debts (contact_id);

ALTER TABLE wacrm.billing_debts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.billing_debts FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.billing_debts TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('271_billing_debts') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
