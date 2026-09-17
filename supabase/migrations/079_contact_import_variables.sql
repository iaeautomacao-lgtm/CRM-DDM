-- Migration 079: persistência de VAR1/VAR2/VAR3 do CSV por contato,
-- para resolução via template_variable_map (type: "csv_var").
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

-- draft_id (sem FK, igual a wacrm.disparador_utm_links — migration 076):
-- o import de contatos roda ANTES da campanha existir quando o usuário
-- está criando uma campanha nova (o insert em wacrm.campaigns só
-- acontece no Step 3 do wizard, depois do upload do CSV no Step 2) — se
-- campaign_id fosse NOT NULL/único ponto de referência, o insert das
-- variáveis falharia por violação de FK nesse caso. campaign_id fica
-- populado só quando o import acontece numa edição de campanha já
-- existente; para campanha nova, grava-se draft_id e o campanhas/page.tsx
-- reatribui campaign_id depois que o insert da campanha é confirmado
-- (mesmo padrão do relink de disparador_utm_links).
CREATE TABLE IF NOT EXISTS wacrm.contact_import_variables (
  id uuid PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
  contact_id uuid NOT NULL REFERENCES wacrm.contacts(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES wacrm.campaigns(id) ON DELETE CASCADE,
  draft_id uuid,
  var_index smallint NOT NULL, -- 0=VAR1, 1=VAR2, 2=VAR3
  value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Duas constraints separadas (não uma única com as duas colunas) porque
  -- só uma delas é não-nula por linha — cada uma dedup dentro do seu
  -- próprio modo (edição vs. rascunho), sem interferir uma na outra.
  UNIQUE (contact_id, campaign_id, var_index),
  UNIQUE (contact_id, draft_id, var_index)
);

CREATE INDEX IF NOT EXISTS idx_contact_import_variables_contact_campaign
  ON wacrm.contact_import_variables (contact_id, campaign_id);
