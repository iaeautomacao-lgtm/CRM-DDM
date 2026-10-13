-- ============================================================
-- 336_campaign_template_pause.sql   (decisão do dono 13/10, item 6 — template PAUSED/DISABLED pausa a campanha na hora)
--
-- Quando a Meta pausa ou desativa um template (message_template_status_update), as campanhas EM EXECUÇÃO que o usam são pausadas na hora
-- (stop_dispatch_campaign), com o motivo legível em campaigns.pausa_automatica_motivo (já exibido no Monitor). Para a retomada
-- automática distinguir "pausada por template" de "pausada pelo operador / pela taxa de erro", a campanha guarda QUAL template a pausou:
--   campaigns.pausa_template_nome    nome do template que causou a pausa;
--   campaigns.pausa_template_idioma  idioma dele.
-- Quando o template volta a APPROVED, só as campanhas com essa marca (e com TODOS os templates delas aprovados) são retomadas.
--
-- Colunas nullable, sem default (instantâneo). COMPATIBILIDADE: sem elas a campanha ainda é pausada na hora (motivo só em
-- pausa_automatica_motivo/log), mas a retomada automática não acontece (o operador retoma na tela). Antes ou depois do deploy.
-- PRÉ-CHECK: SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='campaigns'
--             AND column_name IN ('pausa_template_nome','pausa_template_idioma');   -- 0 linhas
-- ROLLBACK:  ALTER TABLE wacrm.campaigns DROP COLUMN IF EXISTS pausa_template_nome, DROP COLUMN IF EXISTS pausa_template_idioma;
-- Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.campaigns') IS NULL THEN
    RAISE EXCEPTION '336: falta wacrm.campaigns';
  END IF;
END $$;

ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS pausa_template_nome text,
  ADD COLUMN IF NOT EXISTS pausa_template_idioma text;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('336_campaign_template_pause') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
