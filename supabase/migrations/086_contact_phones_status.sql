-- Migration 086: status por telefone em wacrm.contact_phones.
-- APLICAR MANUALMENTE ANTES DO DEPLOY.

ALTER TABLE wacrm.contact_phones
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ativo'
    CHECK (status IN ('ativo', 'invalido', 'respondeu'));

ALTER TABLE wacrm.contact_phones
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;

ALTER TABLE wacrm.contact_phones
  ADD COLUMN IF NOT EXISTS label text;
  -- ex: "Celular", "Fixo", "WhatsApp" — opcional, preenchido pelo usuário

COMMENT ON COLUMN wacrm.contact_phones.status IS
  'ativo = nunca tentado ou tentado com sucesso;
   invalido = erro permanente Meta (131030/131045/131047/131021);
   respondeu = contato respondeu a partir deste número';
