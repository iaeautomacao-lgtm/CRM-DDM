-- Migration 132: vínculo explícito entre import de CSV e campanha.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.
-- Conferir o schema live antes (CLAUDE.md) — campaigns não tem CREATE
-- TABLE nos arquivos de migration.
--
-- Bug corrigido (PRD-01): o import só gravava contact_import_variables
-- quando o CSV tinha colunas VAR, e startCampaign só filtrava pelo import
-- quando não havia tabulação. CSV sem VARs ou CSV + tabulação enviavam
-- para a conta inteira / para todos com a tag.
--
-- disp_import_contacts: todo contato de um import feito pelo wizard
-- (draft_id antes da campanha existir; campaign_id ao editar).
-- campaigns.audience_mode: o que o usuário escolheu ('csv' | 'tags' |
-- 'account'); com 'csv', startCampaign recusa iniciar sem vínculo.

BEGIN;

CREATE TABLE IF NOT EXISTS wacrm.disp_import_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  draft_id uuid,
  campaign_id uuid REFERENCES wacrm.campaigns(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES wacrm.contacts(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (draft_id IS NOT NULL OR campaign_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS disp_import_contacts_draft_contact
  ON wacrm.disp_import_contacts (draft_id, contact_id) WHERE draft_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS disp_import_contacts_campaign_contact
  ON wacrm.disp_import_contacts (campaign_id, contact_id) WHERE campaign_id IS NOT NULL;

-- Só o servidor (service role) lê e escreve.
ALTER TABLE wacrm.disp_import_contacts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.disp_import_contacts FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.disp_import_contacts TO service_role;

ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS audience_mode text
  CHECK (audience_mode IS NULL OR audience_mode IN ('csv', 'tags', 'account'));

COMMIT;
