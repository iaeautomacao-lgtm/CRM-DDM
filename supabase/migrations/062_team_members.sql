-- 062_team_members.sql
-- Tabela de vínculo muitos-para-muitos entre agentes e equipes.
-- Substitui o campo escalar profiles.team_id para suportar múltiplas equipes por agente.
-- Aplicada manualmente no banco em 17/08/2026 antes desta migration ser versionada.

CREATE TABLE IF NOT EXISTS wacrm.team_members (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  team_id     uuid NOT NULL REFERENCES wacrm.teams(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz DEFAULT now(),
  UNIQUE(team_id, user_id)
);

ALTER TABLE wacrm.team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "team_members_select" ON wacrm.team_members
  FOR SELECT USING (
    auth.uid() IN (
      SELECT p.user_id
      FROM wacrm.profiles p
      JOIN wacrm.teams t ON t.id = team_members.team_id
      WHERE p.account_id = t.account_id
    )
  );

CREATE POLICY "team_members_insert" ON wacrm.team_members
  FOR INSERT WITH CHECK (
    auth.uid() IN (
      SELECT p.user_id
      FROM wacrm.profiles p
      JOIN wacrm.teams t ON t.id = team_members.team_id
      WHERE p.account_id = t.account_id
      AND p.account_role IN ('owner', 'admin')
    )
  );

CREATE POLICY "team_members_delete" ON wacrm.team_members
  FOR DELETE USING (
    auth.uid() IN (
      SELECT p.user_id
      FROM wacrm.profiles p
      JOIN wacrm.teams t ON t.id = team_members.team_id
      WHERE p.account_id = t.account_id
      AND p.account_role IN ('owner', 'admin')
    )
  );
