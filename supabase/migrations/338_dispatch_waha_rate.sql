-- ============================================================
-- 338_dispatch_waha_rate.sql   (decisão do dono 13/10, item 20 — ritmo do WAHA)
--
-- O WAHA não tem a regra de qualidade da Meta (dispatch_channel_rate, migration 190), mas precisa de um freio por sessão: limite de
-- mensagens POR SEGUNDO, editável por linha, aplicado pelo agendador do cron (balde de fichas por número, o mesmo da Meta).
--   wacrm.dispatch_waha_rate (session_id PK → whatsapp_config.id, account_id, rate_per_second, reason, updated_by, updated_at)
-- Sem linha para a sessão vale o PADRÃO CONSERVADOR de 1 msg/s (constante no código: DEFAULT_WAHA_RATE_PER_SECOND). A linha só existe
-- quando alguém muda o valor. Faixa: 0,1 a 20 msg/s (CHECK). Tabela só do servidor (RLS sem policy; a tela usa a rota
-- /api/disparador/waha-rate, com a permissão campaigns.rate_limit, motivo e auditoria).
--
-- COMPATIBILIDADE: sem esta migration o cron usa o padrão de 1 msg/s para toda sessão WAHA (a leitura falha e cai no padrão);
-- só a edição pela tela fica indisponível (503). Pode ser aplicada antes ou depois do deploy.
-- PRÉ-CHECK: SELECT to_regclass('wacrm.dispatch_waha_rate');   -- NULL na 1ª vez
-- ROLLBACK:  DROP TABLE IF EXISTS wacrm.dispatch_waha_rate;
-- Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.whatsapp_config') IS NULL OR to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '338: faltam wacrm.whatsapp_config/accounts — confira o schema vivo';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.dispatch_waha_rate (
  session_id      uuid PRIMARY KEY REFERENCES wacrm.whatsapp_config(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  rate_per_second numeric(6, 2) NOT NULL CHECK (rate_per_second >= 0.1 AND rate_per_second <= 20),
  reason          text,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dispatch_waha_rate_account ON wacrm.dispatch_waha_rate (account_id);

ALTER TABLE wacrm.dispatch_waha_rate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.dispatch_waha_rate FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.dispatch_waha_rate TO service_role;

-- 2FA (migration 310): se já aplicada, cobre a tabela aqui (idempotente); se não, a 310 cobre depois.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'wacrm' AND p.proname = 'apply_mfa_policy'
  ) THEN
    PERFORM wacrm.apply_mfa_policy('wacrm.dispatch_waha_rate'::regclass);
  END IF;
END $$;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('338_dispatch_waha_rate') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
