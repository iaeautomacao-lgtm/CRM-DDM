-- Migration 129: CPF em wacrm.disparador_utm_links.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.
--
-- O link UTM é gerado por CPF no utmpay, mas era gravado só pelo telefone
-- CRU do CSV, enquanto o import salva o contato com DDI (+55) — no envio a
-- chave não casava e o {{n}} do link saía vazio. Agora o envio
-- (startCampaign + src/lib/disparador/utm-links.ts) procura pelo CPF do
-- contato (contacts.cpf, migration 077) e depois pelo telefone.
-- Conferir o schema live antes (CLAUDE.md).

ALTER TABLE wacrm.disparador_utm_links
  ADD COLUMN IF NOT EXISTS cpf text;

CREATE INDEX IF NOT EXISTS idx_disparador_utm_links_campaign_cpf
  ON wacrm.disparador_utm_links (campaign_id, cpf)
  WHERE cpf IS NOT NULL;
