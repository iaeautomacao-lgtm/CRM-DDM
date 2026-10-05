-- Migration 144: dias da semana permitidos para envio da campanha.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.
-- Conferir o schema live antes (CLAUDE.md).
--
-- 0 = domingo … 6 = sábado (fuso de Brasília). NULL/vazio = todos os dias
-- (comportamento de antes). Coluna nova porque dias_permitidos já é usado
-- para outra coisa (modo de templates — ver startCampaign.ts).

BEGIN;

ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS dias_envio smallint[];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'campaigns_dias_envio_check' AND conrelid = 'wacrm.campaigns'::regclass
  ) THEN
    ALTER TABLE wacrm.campaigns
      ADD CONSTRAINT campaigns_dias_envio_check
      CHECK (dias_envio IS NULL OR dias_envio <@ ARRAY[0,1,2,3,4,5,6]::smallint[]);
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
