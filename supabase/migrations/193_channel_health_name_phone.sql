-- ============================================================
-- 193_channel_health_name_phone.sql   (TASK24 — nome e telefone dos números iguais à tela Canais)
--
-- A tela Canais lê AO VIVO da Meta (phone_info.verified_name / display_phone_number). As telas do disparador (Números, Controles,
-- Monitor, Erros, Desempenho) liam whatsapp_config.display_phone_number gravado (pode estar velho) e não havia coluna de nome.
-- channel_health (migration 190) passa a guardar o último verified_name e display_phone_number devolvidos pelo Graph; o poll
-- (/api/disparador/health/cron) e o webhook de qualidade os preenchem e corrigem whatsapp_config.display_phone_number quando a
-- Meta devolve outro valor.
--
-- PRÉ-CHECK (rodar antes e conferir):
--   SELECT to_regclass('wacrm.channel_health');                                    -- não nulo (migration 190)
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema='wacrm' AND table_name='channel_health'
--      AND column_name IN ('verified_name','display_phone_number');                -- vazio na 1ª aplicação
-- ORDEM: aplicar ANTES ou DEPOIS do deploy (o app detecta a ausência das colunas e segue sem nome/telefone da Meta).
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.channel_health') IS NULL THEN
    RAISE EXCEPTION '193: falta wacrm.channel_health (migration 190)';
  END IF;
END $$;

ALTER TABLE wacrm.channel_health
  ADD COLUMN IF NOT EXISTS verified_name text,
  ADD COLUMN IF NOT EXISTS display_phone_number text;

NOTIFY pgrst, 'reload schema';

COMMIT;
