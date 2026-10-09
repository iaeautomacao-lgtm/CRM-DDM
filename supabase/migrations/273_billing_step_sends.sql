-- ============================================================
-- 273_billing_step_sends.sql   (PRD 17, PR 17.1 — régua de cobrança: envios por etapa; a base da IDEMPOTÊNCIA)
--
-- Uma linha por (inscrição, etapa), `UNIQUE (enrollment_id, step_id)`: a etapa só pode ser reservada UMA vez, mesmo com dois ticks
-- concorrentes, retry ou restart. `send_key` determinística (`regua:<inscrição>:<etapa>`) vira a chave de envio/idempotência no disparador.
-- Estados: reserved → enqueued → sent → delivered/read | error; ou cancelled (parada/guarda de pré-envio), expired (passou da tolerância),
-- deferred (teto diário), quality_blocked (número RED: a régua não confirma RED sozinha).
-- `contact_id` é cópia de propósito: o teto por devedor/dia vira UMA leitura de índice (sem varrer envios nem dívidas).
-- `queue_item_id` liga ao item da fila do disparador (PR 17.4). Sem FK: a fila pode ser limpa sem apagar a prova do que foi cobrado.
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.billing_enrollments'), to_regclass('wacrm.billing_ruler_steps');  -- não nulos (270, 272)
-- ROLLBACK:   BEGIN; DROP TABLE IF EXISTS wacrm.billing_step_sends; DELETE FROM wacrm.schema_migrations WHERE version = '273_billing_step_sends'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.billing_enrollments') IS NULL OR to_regclass('wacrm.billing_ruler_steps') IS NULL OR to_regclass('wacrm.contacts') IS NULL THEN
    RAISE EXCEPTION '273: faltam wacrm.billing_enrollments/billing_ruler_steps/contacts (migrations 270 e 272)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.billing_step_sends (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL REFERENCES wacrm.billing_enrollments(id) ON DELETE CASCADE,
  contact_id    uuid NOT NULL REFERENCES wacrm.contacts(id) ON DELETE CASCADE,        -- desnormalizado: o teto diário por devedor conta por contato (índice abaixo)
  step_id       uuid NOT NULL REFERENCES wacrm.billing_ruler_steps(id) ON DELETE CASCADE,
  status        text NOT NULL DEFAULT 'reserved' CHECK (status IN
                  ('reserved', 'enqueued', 'sent', 'delivered', 'read', 'error', 'cancelled', 'expired', 'deferred', 'quality_blocked')),
  due_at        timestamptz NOT NULL,
  send_key      text NOT NULL,
  queue_item_id uuid,
  error_code    text CHECK (error_code IS NULL OR length(error_code) <= 100),
  reserved_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_billing_send_enrollment_step UNIQUE (enrollment_id, step_id),
  CONSTRAINT uq_billing_send_key UNIQUE (send_key)
);
CREATE INDEX IF NOT EXISTS idx_billing_sends_status_due ON wacrm.billing_step_sends (status, due_at);
CREATE INDEX IF NOT EXISTS idx_billing_sends_contact_day ON wacrm.billing_step_sends (contact_id, reserved_at);
CREATE INDEX IF NOT EXISTS idx_billing_sends_queue_item ON wacrm.billing_step_sends (queue_item_id) WHERE queue_item_id IS NOT NULL;

ALTER TABLE wacrm.billing_step_sends ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.billing_step_sends FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.billing_step_sends TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('273_billing_step_sends') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
