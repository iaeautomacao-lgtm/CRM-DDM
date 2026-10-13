-- ============================================================
-- 337_ops_alert_dedupe.sql   (decisão do dono 13/10, item 5 — alertas ativos do Disparador)
--
-- Os alertas ativos (campaign.auto_paused, channel.quality_changed, dispatch.cron_stalled) vão para os webhooks de saída e para o push de
-- admin/proprietário. Para não encher a caixa de ninguém, cada alerta é AGRUPADO por campanha/número/cron e por hora: o 1º da hora
-- sai, os repetidos da mesma hora são descartados. A reserva é atômica no banco (vale entre processos e reinícios do Passenger):
--   wacrm.alert_dedupe             (account_id, alert_key, bucket) PK — tabela FECHADA (RLS sem policy, só service_role)
--   wacrm.claim_alert_slot(p_account uuid, p_key text, p_bucket timestamptz) → boolean   true = 1º da hora (pode enviar)
-- A limpeza é barata e feita na própria reserva (linhas com mais de 2 dias). Sem esta migration o envio continua, com dedupe só em
-- memória do processo (melhor esforço). NÃO muda nenhuma função/tabela existente.
-- PRÉ-CHECK: SELECT to_regclass('wacrm.alert_dedupe'), (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--             WHERE n.nspname = 'wacrm' AND p.proname = 'claim_alert_slot');   -- NULL, 0 na 1ª vez
-- ROLLBACK:  DROP FUNCTION IF EXISTS wacrm.claim_alert_slot(uuid, text, timestamptz); DROP TABLE IF EXISTS wacrm.alert_dedupe;
-- Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '337: falta wacrm.accounts — confira o schema vivo';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.alert_dedupe (
  account_id uuid        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  alert_key  text        NOT NULL CHECK (char_length(alert_key) BETWEEN 1 AND 200),
  bucket     timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, alert_key, bucket)
);
CREATE INDEX IF NOT EXISTS idx_alert_dedupe_created ON wacrm.alert_dedupe (created_at);

ALTER TABLE wacrm.alert_dedupe ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.alert_dedupe FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.alert_dedupe TO service_role;

CREATE OR REPLACE FUNCTION wacrm.claim_alert_slot(p_account uuid, p_key text, p_bucket timestamptz)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_n integer;
BEGIN
  IF p_account IS NULL OR p_key IS NULL OR p_bucket IS NULL THEN RETURN false; END IF;
  DELETE FROM wacrm.alert_dedupe WHERE created_at < now() - interval '2 days';
  INSERT INTO wacrm.alert_dedupe (account_id, alert_key, bucket) VALUES (p_account, p_key, p_bucket)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.claim_alert_slot(uuid, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.claim_alert_slot(uuid, text, timestamptz) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('337_ops_alert_dedupe') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
