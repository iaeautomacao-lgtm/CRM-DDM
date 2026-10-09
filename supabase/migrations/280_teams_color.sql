-- ============================================================
-- 280_teams_color.sql   (PRD 23, item 12 — cor por equipe no Inbox)
--
-- teams.color: cor da equipe, de uma PALETA FECHADA (10 cores). O cadastro de equipe grava direto pela API do Supabase, então a validação
-- fica no BANCO (CHECK): qualquer cor fora da paleta é recusada. A mesma lista está em src/lib/teams/palette.ts (um teste confere que as duas
-- não divergem). NULL = equipe sem cor (todas as existentes continuam assim; nada é preenchido).
--
-- ADD COLUMN nula, sem DEFAULT: só catálogo. Tabela pequena (equipes por conta). Sem índice.
-- COMPATIBILIDADE: nenhuma rota depende da coluna; o front lê/grava `color` quando a migration existir. ANTES ou DEPOIS do deploy.
--
-- PRÉ-CHECK:  SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='teams' AND column_name='color';  -- 0 linhas
-- ROLLBACK:   ALTER TABLE wacrm.teams DROP CONSTRAINT IF EXISTS teams_color_palette; ALTER TABLE wacrm.teams DROP COLUMN IF EXISTS color;
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.teams') IS NULL THEN
    RAISE EXCEPTION '280: falta wacrm.teams (migration 049)';
  END IF;
END $$;

ALTER TABLE wacrm.teams ADD COLUMN IF NOT EXISTS color text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_color_palette' AND conrelid = 'wacrm.teams'::regclass) THEN
    ALTER TABLE wacrm.teams
      ADD CONSTRAINT teams_color_palette
      CHECK (color IS NULL OR color IN (
        '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#64748b'
      ));
  END IF;
END $$;

COMMENT ON COLUMN wacrm.teams.color IS 'Cor da equipe no Inbox (paleta fechada, ver CHECK teams_color_palette). NULL = sem cor.';

-- Registro (migration 202). Tolerante a banco sem a 202.
DO $$
BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('280_teams_color') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
