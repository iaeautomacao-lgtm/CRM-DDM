-- ============================================================
-- 260_whatsapp_flows.sql   (PRD 21, PR-21.1 — respostas de WhatsApp Flow e base para os Flows)
--
-- O QUE FAZ (aditiva; nada existente é alterado ou removido):
--   1. wacrm.messages.flow_response jsonb — o `response_json` que o cliente preenche no formulário (WhatsApp Flow) e a Meta entrega em
--      `interactive.nfm_reply`. Antes o webhook gravava "[Interactive reply]" e o JSON era DESCARTADO (FLOW-01). Preenchida só nessas
--      mensagens; NULL em todas as demais.
--   2. wacrm.whatsapp_config.flows_public_key / flows_private_key_enc — par RSA do endpoint de Data Exchange (PR-21.2). A chave PRIVADA é
--      sempre gravada CIFRADA pelo servidor (nunca em texto puro, nunca no .env); nesta PR as colunas só existem.
--   3. wacrm.whatsapp_flows — metadados dos Flows registrados na Meta por canal (status DRAFT/PUBLISHED/DEPRECATED/BLOCKED), usada pelas
--      PRs 21.3/21.4 (validar PUBLISHED antes de agendar campanha; nó send_flow). Leitura por membro da conta; escrita só pelo servidor.
-- O app NÃO depende desta migration para continuar recebendo mensagens: sem a coluna flow_response, o webhook grava a resposta só como
-- texto legível e registra o alerta `flow_response_column_missing` (nenhuma mensagem se perde).
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.messages'), to_regclass('wacrm.whatsapp_config'), to_regclass('wacrm.accounts');         -- todos não nulos
--   SELECT data_type FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='whatsapp_config' AND column_name='id';  -- uuid
--   SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name='messages' AND column_name='flow_response';  -- 0 linhas na 1ª vez
--   SELECT to_regprocedure('wacrm.current_account_id()');                                                              -- não nulo
-- VERIFICAÇÃO (depois): SELECT column_name FROM information_schema.columns WHERE table_schema='wacrm' AND table_name IN ('messages','whatsapp_config')
--   AND column_name IN ('flow_response','flows_public_key','flows_private_key_enc'); -- 3 linhas · SELECT to_regclass('wacrm.whatsapp_flows');
-- ORDEM: antes ou depois do deploy. Idempotente. ADD COLUMN sem DEFAULT em messages é só catálogo (não reescreve a tabela).
-- ROLLBACK:
--   BEGIN;
--   DROP TABLE IF EXISTS wacrm.whatsapp_flows;
--   ALTER TABLE wacrm.whatsapp_config DROP COLUMN IF EXISTS flows_private_key_enc, DROP COLUMN IF EXISTS flows_public_key;
--   ALTER TABLE wacrm.messages DROP COLUMN IF EXISTS flow_response;   -- apaga as respostas já gravadas: só se não houver mais uso
--   DELETE FROM wacrm.schema_migrations WHERE version = '260_whatsapp_flows';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.messages') IS NULL OR to_regclass('wacrm.whatsapp_config') IS NULL OR to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '260: faltam wacrm.messages/whatsapp_config/accounts — confira o schema vivo';
  END IF;
  IF to_regprocedure('wacrm.current_account_id()') IS NULL THEN
    RAISE EXCEPTION '260: falta wacrm.current_account_id() (isolamento por conta)';
  END IF;
END $$;

ALTER TABLE wacrm.messages ADD COLUMN IF NOT EXISTS flow_response jsonb;

ALTER TABLE wacrm.whatsapp_config
  ADD COLUMN IF NOT EXISTS flows_public_key text,
  ADD COLUMN IF NOT EXISTS flows_private_key_enc text;

CREATE TABLE IF NOT EXISTS wacrm.whatsapp_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES wacrm.whatsapp_config(id) ON DELETE CASCADE,
  meta_flow_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'DEPRECATED', 'BLOCKED')),
  categories text[] NOT NULL DEFAULT '{}',
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  preview_url text,
  json_schema jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_whatsapp_flows_channel_meta_flow UNIQUE (channel_id, meta_flow_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_flows_account ON wacrm.whatsapp_flows (account_id);

ALTER TABLE wacrm.whatsapp_flows ENABLE ROW LEVEL SECURITY;

-- Membro da conta LÊ; gravar é só do servidor (service role ignora RLS): sem policy de escrita para authenticated.
DROP POLICY IF EXISTS whatsapp_flows_select ON wacrm.whatsapp_flows;
CREATE POLICY whatsapp_flows_select ON wacrm.whatsapp_flows
  FOR SELECT TO authenticated
  USING (account_id = (SELECT wacrm.current_account_id()));

REVOKE ALL ON wacrm.whatsapp_flows FROM anon, authenticated;
GRANT SELECT ON wacrm.whatsapp_flows TO authenticated;   -- só leitura (a RLS acima restringe à conta); escrita = service_role
GRANT ALL ON wacrm.whatsapp_flows TO service_role;

-- Registro (202): tolera banco sem a 202 ainda; idempotente.
DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('260_whatsapp_flows') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
