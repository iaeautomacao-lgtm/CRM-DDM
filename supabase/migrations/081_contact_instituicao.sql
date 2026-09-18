-- Migration 081: campo de instituição de ensino por contato.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.
--
-- "company" (existente desde 001_initial_schema.sql) é mantido por
-- compatibilidade — continua em uso em vários pontos do produto (ver
-- contact-form.tsx, contact-detail-view.tsx, import-modal.tsx, disparador
-- template-vars.ts, entre outros). "instituicao" é o campo específico da
-- DDM para contexto educacional de cobrança (nome da escola/faculdade do
-- aluno), distinto de "empresa" — não substitui nem deriva de "company".
ALTER TABLE wacrm.contacts
  ADD COLUMN IF NOT EXISTS instituicao text;
