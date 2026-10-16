-- ============================================================
-- 381_teams_first_response_sla.sql   (SLA de primeira resposta configurável POR EQUIPE)
--
-- O QUE FAZ: wacrm.teams.first_response_sla_min (integer, NULL, 1..1440 minutos). NULL = a equipe usa o padrão da conta. O padrão da conta NÃO ganha coluna:
--   é a chave 'first_response_sla_min' do registro de configurações (wacrm.account_settings, migration 231; src/lib/settings/account-config.ts), e
--   ausente/NULL = 15 min (o valor fixo de hoje: src/lib/monitoramento/sla.ts). Quem usa o valor: Monitoramento (painel de SLA e drilldown) via
--   GET /api/sla/config e src/lib/sla/config.ts (ponto único). Sem tabela nova, sem índice (equipes por conta são poucas), sem RLS nova: a leitura
--   segue a policy teams_select (teams.view) e a escrita é só pela API (PATCH /api/account/teams/{id}, teams.manage; admin/owner), com auditoria
--   team.sla_changed (antes/depois, só valores e id).
-- COMPATIBILIDADE: ADD COLUMN nula, sem DEFAULT: só catálogo, não reescreve a tabela. Sem a migration o código usa 15 para todas as equipes e a rota de
--   escrita responde 503. ANTES ou DEPOIS do deploy.
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.teams');                                                                                                   -- não nulo
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='teams' AND column_name='first_response_sla_min';  -- 0 linhas na 1ª vez
--   SELECT conname FROM pg_constraint WHERE conrelid = 'wacrm.teams'::regclass AND conname = 'teams_first_response_sla_range';             -- 0 linhas na 1ª vez
-- VERIFICAÇÃO (depois): SELECT id, first_response_sla_min FROM wacrm.teams LIMIT 3;   -- coluna existe (NULL); UPDATE com 0 ou 1441 falha na CHECK
-- ROLLBACK:
--   ALTER TABLE wacrm.teams DROP CONSTRAINT IF EXISTS teams_first_response_sla_range;
--   ALTER TABLE wacrm.teams DROP COLUMN IF EXISTS first_response_sla_min;
--   DELETE FROM wacrm.schema_migrations WHERE version = '381_teams_first_response_sla';
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.teams') IS NULL THEN
    RAISE EXCEPTION '381: falta wacrm.teams (migration 049) — confira o schema vivo';
  END IF;
END $$;

ALTER TABLE wacrm.teams ADD COLUMN IF NOT EXISTS first_response_sla_min integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_first_response_sla_range' AND conrelid = 'wacrm.teams'::regclass) THEN
    ALTER TABLE wacrm.teams
      ADD CONSTRAINT teams_first_response_sla_range
      CHECK (first_response_sla_min IS NULL OR first_response_sla_min BETWEEN 1 AND 1440);
  END IF;
END $$;

COMMENT ON COLUMN wacrm.teams.first_response_sla_min IS 'Meta de primeira resposta da equipe, em minutos (1..1440). NULL = padrão da conta (account_settings.first_response_sla_min; ausente = 15).';

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('381_teams_first_response_sla') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
