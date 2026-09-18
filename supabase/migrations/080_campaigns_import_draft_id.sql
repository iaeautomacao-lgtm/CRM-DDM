-- Migration 080: rastreia o draft_id usado na importação de CSV de cada
-- campanha, para permitir relink determinístico de
-- wacrm.contact_import_variables (e futuramente disparador_utm_links) sem
-- depender de heurística de "draft mais recente da conta" — heurística
-- que arrisca vincular variáveis de OUTRO draft/campanha da mesma conta
-- (ver incidente: 46 contatos com VAR2 vazio por falha silenciosa do
-- relink em campanhas/page.tsx).
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

ALTER TABLE wacrm.campaigns
  ADD COLUMN IF NOT EXISTS import_draft_id uuid;
