-- ============================================================
-- 355_acordito_enabled_default.sql   (decisão do dono 14/10: "O Acordito tem que nascer ligado!")
--
-- O código já trata conta sem linha em wacrm.copilot_config como LIGADA (src/lib/ai/copilot.ts). Aqui só alinha o padrão da
-- coluna: linha nova nasce com enabled = true. Contas que já desligaram o Acordito (enabled = false) NÃO mudam.
-- ORDEM: depois da 354; antes ou depois do deploy. Idempotente.
-- PRÉ-CHECK:  SELECT column_default FROM information_schema.columns
--              WHERE table_schema = 'wacrm' AND table_name = 'copilot_config' AND column_name = 'enabled';   -- 'false' antes
-- VERIFICAÇÃO: a mesma consulta devolve 'true'.
-- ROLLBACK:   BEGIN;
--             ALTER TABLE wacrm.copilot_config ALTER COLUMN enabled SET DEFAULT false;
--             DELETE FROM wacrm.schema_migrations WHERE version = '355_acordito_enabled_default';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.copilot_config') IS NULL THEN
    RAISE EXCEPTION '355: rode antes a 354_acordito_copilot (wacrm.copilot_config não existe)';
  END IF;
END $$;

ALTER TABLE wacrm.copilot_config ALTER COLUMN enabled SET DEFAULT true;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('355_acordito_enabled_default') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
