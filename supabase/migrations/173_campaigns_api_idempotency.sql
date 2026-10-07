-- ============================================================
-- 173_campaigns_api_idempotency.sql
--
-- Idempotência opcional da criação de campanha pela API pública
-- (POST /api/v1/disparador/campaigns): header Idempotency-Key ou
-- external_id no corpo.
--
--  - idempotency_key   : "idem:<header>" ou "ext:<external_id>" (nulo para
--                        campanhas da tela e chamadas sem chave).
--  - idempotency_hash  : SHA-256 do conteúdo (JSON estável) — repetir a
--                        chave com outro conteúdo devolve 409.
--  - idempotency_response : corpo da resposta de criação, devolvido tal
--                        qual na repetição (200). Nulo = criação em curso.
--  - índice único PARCIAL (account_id, idempotency_key): duas requisições
--    concorrentes com a mesma chave nunca criam duas campanhas.
--
-- PRÉ-CHECK (deve devolver 0 linhas; a tabela é pequena, então o índice é
-- criado sem CONCURRENTLY, dentro da transação):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema = 'wacrm' AND table_name = 'campaigns'
--     AND column_name IN ('idempotency_key','idempotency_hash','idempotency_response');
--
-- ORDEM: aplicar ANTES do deploy do código (o código novo grava estas
-- colunas só quando o cliente envia a chave). Idempotente.
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.campaigns') IS NULL THEN
    RAISE EXCEPTION 'wacrm.campaigns não existe';
  END IF;
END $$;

ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS idempotency_hash text,
  ADD COLUMN IF NOT EXISTS idempotency_response jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaigns_account_idempotency_key
  ON wacrm.campaigns (account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMIT;

NOTIFY pgrst, 'reload schema';
