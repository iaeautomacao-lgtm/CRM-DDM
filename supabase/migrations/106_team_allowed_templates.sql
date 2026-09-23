-- Migration 106: wacrm.team_allowed_templates — quais templates
-- (wacrm.message_templates) um time pode usar. Ausência de qualquer
-- linha para um team_id = sem restrição (todos os templates
-- aprovados ficam liberados) — essa regra é enforced pelo código que
-- consome esta tabela, não pelo schema.
-- APLICAR MANUALMENTE no Supabase SQL Editor ANTES do deploy.

-- RLS espelha wacrm.team_members (migration 062) exatamente: SELECT
-- pra qualquer membro da mesma conta do time; INSERT/DELETE só
-- admin+. Sem policy de UPDATE — a relação é só presença/ausência da
-- linha, nunca editada in-place.
CREATE TABLE IF NOT EXISTS wacrm.team_allowed_templates (
  team_id     UUID NOT NULL REFERENCES wacrm.teams(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES wacrm.message_templates(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (team_id, template_id)
);

ALTER TABLE wacrm.team_allowed_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "team_allowed_templates_select" ON wacrm.team_allowed_templates
  FOR SELECT USING (
    auth.uid() IN (
      SELECT p.user_id
      FROM wacrm.profiles p
      JOIN wacrm.teams t ON t.id = team_allowed_templates.team_id
      WHERE p.account_id = t.account_id
    )
  );

CREATE POLICY "team_allowed_templates_insert" ON wacrm.team_allowed_templates
  FOR INSERT WITH CHECK (
    auth.uid() IN (
      SELECT p.user_id
      FROM wacrm.profiles p
      JOIN wacrm.teams t ON t.id = team_allowed_templates.team_id
      WHERE p.account_id = t.account_id
      AND p.account_role IN ('owner', 'admin')
    )
  );

CREATE POLICY "team_allowed_templates_delete" ON wacrm.team_allowed_templates
  FOR DELETE USING (
    auth.uid() IN (
      SELECT p.user_id
      FROM wacrm.profiles p
      JOIN wacrm.teams t ON t.id = team_allowed_templates.team_id
      WHERE p.account_id = t.account_id
      AND p.account_role IN ('owner', 'admin')
    )
  );
