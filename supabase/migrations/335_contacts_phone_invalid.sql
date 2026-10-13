-- ============================================================
-- 335_contacts_phone_invalid.sql   (AUDIT-DISPARADOR D-05 / decisão do dono 13/10, item 4 — lembrar o número inválido)
--
-- Hoje o telefone PRINCIPAL que a Meta recusa como inválido/sem WhatsApp não é lembrado: toda campanha nova reenvia ao mesmo número,
-- gasta vaga e ritmo e piora a qualidade do número de envio. Esta migration cria a marca no contato:
--   contacts.phone_invalid_at          quando a Meta recusou o telefone principal como inválido (códigos "número inválido" do catálogo);
--   contacts.phone_invalid_normalized  o phone_normalized que foi recusado.
-- A marca SÓ VALE enquanto contacts.phone_normalized continuar igual a phone_invalid_normalized: se o telefone do contato mudar, a marca
-- deixa de valer sozinha (sem trigger, sem limpeza). O opt-out e a blacklist NÃO são tocados (outra tabela, outra regra).
-- O startCampaign pula o contato com marca válida (e sem telefone alternativo utilizável) e devolve a contagem no resumo.
--
-- Colunas nullable, sem default: ADD COLUMN instantâneo, sem reescrever a tabela. O índice parcial de apoio é a 335b (CONCURRENTLY).
-- COMPATIBILIDADE: sem as colunas o código ignora a marca (nada é pulado, nada é gravado). Pode ser aplicada antes ou depois do deploy.
-- PRÉ-CHECK: SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='contacts'
--             AND column_name IN ('phone_invalid_at','phone_invalid_normalized');   -- 0 linhas
-- ROLLBACK:  ALTER TABLE wacrm.contacts DROP COLUMN IF EXISTS phone_invalid_at, DROP COLUMN IF EXISTS phone_invalid_normalized;
-- Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.contacts') IS NULL THEN
    RAISE EXCEPTION '335: falta wacrm.contacts';
  END IF;
END $$;

ALTER TABLE wacrm.contacts
  ADD COLUMN IF NOT EXISTS phone_invalid_at timestamptz,
  ADD COLUMN IF NOT EXISTS phone_invalid_normalized text;

COMMENT ON COLUMN wacrm.contacts.phone_invalid_at IS
  'Quando a Meta recusou o telefone principal como inválido/sem WhatsApp. Só vale enquanto phone_normalized = phone_invalid_normalized.';

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('335_contacts_phone_invalid') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
