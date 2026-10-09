-- ============================================================
-- 291_whatsapp_flows_keys.sql   (PRD 21, PR 21.2 — par RSA do Data Exchange dos WhatsApp Flows, por canal)
--
-- Decisão do dono (09/10): a PLATAFORMA gera o par RSA ao ativar o recurso, guarda a privada CIFRADA por conta e mostra a pública para colar
-- no WhatsApp Manager. Nada vai para o .env.
--
-- POR QUE UMA TABELA FECHADA (e não as colunas flows_* da 260 em whatsapp_config): a leitura de segredos de whatsapp_config pelo navegador
-- foi fechada por LISTA DE COLUNAS (200b). Uma coluna de chave privada ali depende dessa lista estar atualizada em cada banco; aqui a
-- tabela nasce com RLS ligada, SEM policy e SEM privilégio para anon/authenticated — só o servidor (service role) lê.
--   wacrm.whatsapp_flows_keys (channel_id PK, account_id, public_key PEM, private_key_enc [AES-256-GCM da plataforma], created_at, rotated_at)
-- As colunas whatsapp_config.flows_public_key / flows_private_key_enc criadas na 260 NUNCA foram escritas por código nenhum: saem aqui.
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.whatsapp_config'), to_regclass('wacrm.accounts');                       -- não nulos
--             SELECT to_regclass('wacrm.whatsapp_flows_keys');                                                    -- NULL na 1ª vez
--             SELECT count(*) FROM wacrm.whatsapp_config WHERE flows_private_key_enc IS NOT NULL;                  -- 0 (se a coluna ainda existir)
-- ORDEM: antes ou depois do deploy (sem a 291 a rota de chaves responde 503 e o endpoint de Data Exchange 421). Idempotente.
-- ROLLBACK:   BEGIN; DROP TABLE IF EXISTS wacrm.whatsapp_flows_keys;
--             ALTER TABLE wacrm.whatsapp_config ADD COLUMN IF NOT EXISTS flows_public_key text, ADD COLUMN IF NOT EXISTS flows_private_key_enc text;
--             DELETE FROM wacrm.schema_migrations WHERE version = '291_whatsapp_flows_keys'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.whatsapp_config') IS NULL OR to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '291: faltam wacrm.whatsapp_config/accounts — confira o schema vivo';
  END IF;
  -- nunca apaga chave que alguém tenha gravado nas colunas antigas
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'whatsapp_config' AND column_name = 'flows_private_key_enc') THEN
    IF (SELECT count(*) FROM wacrm.whatsapp_config WHERE flows_private_key_enc IS NOT NULL) > 0 THEN
      RAISE EXCEPTION '291: existe chave privada gravada em whatsapp_config.flows_private_key_enc — migre-a para whatsapp_flows_keys antes de continuar';
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.whatsapp_flows_keys (
  channel_id      uuid PRIMARY KEY REFERENCES wacrm.whatsapp_config(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  public_key      text NOT NULL CHECK (public_key LIKE '-----BEGIN PUBLIC KEY-----%'),
  private_key_enc text NOT NULL CHECK (private_key_enc ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$'),   -- iv:ciphertext:authTag (GCM); nunca PEM em claro
  created_at      timestamptz NOT NULL DEFAULT now(),
  rotated_at      timestamptz
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_flows_keys_account ON wacrm.whatsapp_flows_keys (account_id);

ALTER TABLE wacrm.whatsapp_flows_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.whatsapp_flows_keys FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.whatsapp_flows_keys TO service_role;

ALTER TABLE wacrm.whatsapp_config DROP COLUMN IF EXISTS flows_private_key_enc, DROP COLUMN IF EXISTS flows_public_key;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('291_whatsapp_flows_keys') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
