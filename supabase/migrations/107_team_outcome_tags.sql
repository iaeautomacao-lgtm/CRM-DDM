-- Migration 107: wacrm.team_outcome_tags — corrige a relação
-- tabulação <-> equipe de 1:1 (wacrm.tags.team_id, migration 105) para
-- N:N. Uma tabulação (tags com kind='outcome') pode pertencer a mais
-- de uma equipe; tags.team_id só conseguia guardar uma.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

-- RLS espelha wacrm.team_allowed_templates (migration 106) e
-- wacrm.team_members (migration 062) exatamente: SELECT pra qualquer
-- membro da mesma conta do time; INSERT/DELETE só admin+. Sem policy
-- de UPDATE — a relação é só presença/ausência da linha, nunca
-- editada in-place.
CREATE TABLE IF NOT EXISTS wacrm.team_outcome_tags (
  team_id    UUID NOT NULL REFERENCES wacrm.teams(id) ON DELETE CASCADE,
  tag_id     UUID NOT NULL REFERENCES wacrm.tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (team_id, tag_id)
);

ALTER TABLE wacrm.team_outcome_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "team_outcome_tags_select" ON wacrm.team_outcome_tags
  FOR SELECT USING (
    auth.uid() IN (
      SELECT p.user_id FROM wacrm.profiles p
      JOIN wacrm.teams t ON t.id = team_outcome_tags.team_id
      WHERE p.account_id = t.account_id
    )
  );

CREATE POLICY "team_outcome_tags_insert" ON wacrm.team_outcome_tags
  FOR INSERT WITH CHECK (
    auth.uid() IN (
      SELECT p.user_id FROM wacrm.profiles p
      JOIN wacrm.teams t ON t.id = team_outcome_tags.team_id
      WHERE p.account_id = t.account_id
      AND p.account_role IN ('owner', 'admin')
    )
  );

CREATE POLICY "team_outcome_tags_delete" ON wacrm.team_outcome_tags
  FOR DELETE USING (
    auth.uid() IN (
      SELECT p.user_id FROM wacrm.profiles p
      JOIN wacrm.teams t ON t.id = team_outcome_tags.team_id
      WHERE p.account_id = t.account_id
      AND p.account_role IN ('owner', 'admin')
    )
  );

CREATE INDEX IF NOT EXISTS idx_team_outcome_tags_tag ON wacrm.team_outcome_tags(tag_id);

-- Backfill: preserva qualquer atribuição já feita via tags.team_id
-- (migration 105) — idempotente, seguro rodar mesmo se 105 nunca foi
-- populada. tags.team_id fica como coluna legada, não removida aqui
-- (nenhum código a lê mais após esta migration, mas dropar é uma
-- decisão separada, fora do escopo pedido).
INSERT INTO wacrm.team_outcome_tags (team_id, tag_id)
SELECT team_id, id FROM wacrm.tags
WHERE team_id IS NOT NULL AND kind = 'outcome'
ON CONFLICT DO NOTHING;
