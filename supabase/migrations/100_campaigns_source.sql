-- Migration 100: adiciona wacrm.campaigns.source ('dashboard' | 'api_v1').
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

-- Distingue campanhas criadas pelo wizard do dashboard (startCampaign.ts)
-- das criadas via API pública (/api/v1/disparador/campaigns) — nenhuma
-- coluna hoje permite essa distinção (created_by é sempre preenchido nos
-- dois casos: com o usuário logado num, com o criador da API key no
-- outro). Usada pelo teste 12 (api_v1_campaign_status) do health check
-- em /api/stress/run.
--
-- Sem backfill: não há como identificar com segurança a origem de
-- campanhas já existentes (created_by sozinho não distingue), então
-- todas ficam com o DEFAULT 'dashboard' — só campanhas criadas a partir
-- desta migration em diante carregam 'api_v1' corretamente.
ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'dashboard'
  CHECK (source IN ('dashboard', 'api_v1'));
