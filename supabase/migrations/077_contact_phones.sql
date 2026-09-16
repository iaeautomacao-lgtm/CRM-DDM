-- Migration 077: suporte a múltiplos telefones por contato (fundação da
-- escada de números por CPF). Esta migration só cria schema — nenhuma
-- lógica de aplicação ainda lê/escreve estas colunas/tabela.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.
--
-- Schema verificado ao vivo em 2026-09-16 via
-- GET {SUPABASE_URL}/rest/v1/ (Accept-Profile: wacrm) antes de escrever
-- este arquivo:
--   - wacrm.contacts NÃO TEM `cpf`.
--   - wacrm.contact_phones não existe.
--   - wacrm.disp_message_queue NÃO TEM `phone_attempt_order`.
--   Os três itens abaixo são, portanto, adições novas.
--
-- uuid_generate_v4() via extensions.* (não gen_random_uuid()) para bater
-- com o default já usado em todo o resto do schema — ver
-- wacrm.contacts.id, wacrm.disp_message_queue.id, wacrm.campaigns.id.

-- 1. Coluna CPF em contacts (chave de identidade do aluno)
ALTER TABLE wacrm.contacts
  ADD COLUMN IF NOT EXISTS cpf text;

CREATE INDEX IF NOT EXISTS idx_contacts_cpf
  ON wacrm.contacts (cpf)
  WHERE cpf IS NOT NULL;

-- 2. Tabela de telefones alternativos
CREATE TABLE IF NOT EXISTS wacrm.contact_phones (
  id                uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  contact_id        uuid NOT NULL REFERENCES wacrm.contacts(id) ON DELETE CASCADE,
  phone             text NOT NULL,
  phone_normalized  text NOT NULL,
  ordem             smallint NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE(contact_id, ordem)
);

CREATE INDEX IF NOT EXISTS idx_contact_phones_contact
  ON wacrm.contact_phones (contact_id, ordem);

CREATE INDEX IF NOT EXISTS idx_contact_phones_normalized
  ON wacrm.contact_phones (phone_normalized);

-- 3. Coluna em disp_message_queue para rastrear qual número está sendo
-- tentado (índice `ordem` de wacrm.contact_phones).
ALTER TABLE wacrm.disp_message_queue
  ADD COLUMN IF NOT EXISTS phone_attempt_order smallint NOT NULL DEFAULT 1;
