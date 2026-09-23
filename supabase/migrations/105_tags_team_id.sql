-- Migration 105: adiciona wacrm.tags.team_id — permite tabulações
-- (tags com kind='outcome') escopadas a uma equipe específica, além
-- das globais (team_id NULL, visíveis/seleccionáveis por qualquer
-- equipe da conta) já seedadas por wacrm.seed_tabulacao_tags()
-- (migration 041).
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

-- Nenhuma mudança de RLS necessária: tags_select/insert/update/delete
-- (017_account_sharing.sql) já são por account_id, e team_id é só mais
-- uma coluna dentro da mesma linha — não introduz um novo limite de
-- posse a ser verificado.
ALTER TABLE wacrm.tags
  ADD COLUMN team_id UUID REFERENCES wacrm.teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tags_team ON wacrm.tags(team_id);
