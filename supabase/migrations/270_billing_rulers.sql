-- ============================================================
-- 270_billing_rulers.sql   (PRD 17, PR 17.1 — régua de cobrança: réguas e etapas)
--
-- O MOTOR é nosso; o CONTEÚDO é da operação: quais etapas existem, em que dia, com que template/texto, janela, teto e se uma
-- resposta do devedor pausa a régua são CONFIGURAÇÃO por conta (estas tabelas), preenchida na tela. Nada é semeado: a conta nasce
-- sem régua e a régua nasce DESLIGADA e em dry-run (decisão do PRD 17: 1 semana só medindo antes de enviar).
--   wacrm.billing_rulers       uma régua: ativa, dry_run, canal, janela de envio (Brasília), dias da semana, teto por devedor/dia,
--                              tolerância de etapa atrasada, pausa por conversa aberta, prioridade
--   wacrm.billing_ruler_steps  etapas: por deslocamento do vencimento (offset_days: -3 = 3 dias antes, 0 = no dia, +2 = 2 dias depois)
--                              ou por status; template (Meta) OU texto (WAHA) — a bifurcação Meta×WAHA é do envio, não daqui
-- Fechadas: RLS ligada, sem policy; só service_role (rotas /api/billing/* na PR 17.5 e o cron do motor).
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.accounts'), to_regclass('wacrm.whatsapp_config');   -- não nulos
--             SELECT to_regclass('wacrm.billing_rulers');                                    -- NULL na 1ª vez
-- ORDEM: antes ou depois do deploy (o app ainda não usa; a PR 17.3 chega depois). Idempotente. Tabelas novas ⇒ índice comum, sem `b`.
-- ROLLBACK:  BEGIN; DROP TABLE IF EXISTS wacrm.billing_ruler_steps; DROP TABLE IF EXISTS wacrm.billing_rulers;
--            DELETE FROM wacrm.schema_migrations WHERE version = '270_billing_rulers'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL OR to_regclass('wacrm.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION '270: faltam wacrm.accounts/whatsapp_config — confira o schema vivo';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.billing_rulers (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                 uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  name                       text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  active                     boolean NOT NULL DEFAULT false,
  dry_run                    boolean NOT NULL DEFAULT true,          -- calcula e mede, NUNCA envia
  channel_id                 uuid REFERENCES wacrm.whatsapp_config(id) ON DELETE SET NULL,
  window_start               time NOT NULL DEFAULT '08:00',          -- horário de Brasília
  window_end                 time NOT NULL DEFAULT '20:00',
  weekdays                   smallint[] NOT NULL DEFAULT '{1,2,3,4,5}' CHECK (weekdays <@ ARRAY[0,1,2,3,4,5,6]::smallint[] AND cardinality(weekdays) >= 1),
  daily_cap_per_debtor       smallint NOT NULL DEFAULT 1 CHECK (daily_cap_per_debtor BETWEEN 1 AND 10),
  tolerance_days             smallint NOT NULL DEFAULT 1 CHECK (tolerance_days BETWEEN 0 AND 30),
  pause_on_open_conversation boolean NOT NULL DEFAULT false,         -- Decisão da operação; o motor só aplica
  priority                   integer NOT NULL DEFAULT 100,           -- menor = primeiro quando duas réguas disputam o teto
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_rulers_window_order CHECK (window_end > window_start)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_rulers_account_name ON wacrm.billing_rulers (account_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS idx_billing_rulers_account_active ON wacrm.billing_rulers (account_id) WHERE active;

CREATE TABLE IF NOT EXISTS wacrm.billing_ruler_steps (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  ruler_id       uuid NOT NULL REFERENCES wacrm.billing_rulers(id) ON DELETE CASCADE,
  position       integer NOT NULL CHECK (position >= 0),
  kind           text NOT NULL CHECK (kind IN ('offset', 'status')),
  offset_days    integer CHECK (offset_days IS NULL OR offset_days BETWEEN -60 AND 365),
  status_trigger text CHECK (status_trigger IS NULL OR length(status_trigger) BETWEEN 1 AND 60),
  template_id    uuid,                                              -- message_templates.id (canal Meta); sem FK de propósito (template pode ser recriado)
  message_text   text CHECK (message_text IS NULL OR length(message_text) <= 4096),   -- canal WAHA: {{1}} {{2}} {{3}} trocados no código
  conditions     jsonb NOT NULL DEFAULT '{}'::jsonb,                -- ex.: faixa de atraso, valor mínimo (avaliado pelo motor)
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_steps_kind_fields CHECK (
    (kind = 'offset' AND offset_days IS NOT NULL AND status_trigger IS NULL)
    OR (kind = 'status' AND status_trigger IS NOT NULL AND offset_days IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_steps_ruler_position ON wacrm.billing_ruler_steps (ruler_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_steps_ruler_offset ON wacrm.billing_ruler_steps (ruler_id, offset_days) WHERE kind = 'offset';
CREATE INDEX IF NOT EXISTS idx_billing_steps_account ON wacrm.billing_ruler_steps (account_id);

ALTER TABLE wacrm.billing_rulers ENABLE ROW LEVEL SECURITY;
ALTER TABLE wacrm.billing_ruler_steps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.billing_rulers, wacrm.billing_ruler_steps FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.billing_rulers, wacrm.billing_ruler_steps TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('270_billing_rulers') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
