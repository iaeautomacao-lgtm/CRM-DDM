-- Migration 143: Relatórios do supervisor escopados às equipes dele.
-- APLICAR MANUALMENTE no Supabase SQL Editor DEPOIS da 140 (usa
-- current_user_role / current_user_team_ids). Conferir o schema live antes.
--
-- As RPCs de relatório (051/052/053) são SECURITY DEFINER e ignoram a RLS
-- de conversas: liberar /relatorios ao supervisor sem isto mostraria a
-- conta inteira. Aqui cada função ganha um filtro extra que, para owner/
-- admin/viewer, é sempre verdadeiro (nada muda) e, para o supervisor,
-- aplica a MESMA regra da policy conversations_select (140):
--   equipe dele · atribuída a ele · sem equipe atribuída a membro das equipes.
-- Sessões de agentes: só membros das equipes dele (e ele mesmo).
--
-- As funções NÃO são reescritas à mão: a definição em produção é lida com
-- pg_get_functiondef e o filtro é inserido logo após o guard
-- `AND is_account_member(p_account_id)`. Se esse trecho não existir
-- exatamente uma vez (definição diferente da esperada), a migration aborta
-- sem alterar nada. Rodar de novo é seguro (pula o que já tem o filtro).

BEGIN;

CREATE OR REPLACE FUNCTION wacrm.report_sees_conversation(p_team uuid, p_agent uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(wacrm.current_user_role(), '') <> 'supervisor'
    OR p_team IN (SELECT wacrm.current_user_team_ids())
    OR p_agent = auth.uid()
    OR (
      p_team IS NULL
      AND p_agent IN (
        SELECT tm.user_id FROM wacrm.team_members tm
        WHERE tm.team_id IN (SELECT wacrm.current_user_team_ids())
      )
    )
$$;
REVOKE ALL ON FUNCTION wacrm.report_sees_conversation(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.report_sees_conversation(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION wacrm.report_sees_user(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(wacrm.current_user_role(), '') <> 'supervisor'
    OR p_user = auth.uid()
    OR p_user IN (
      SELECT tm.user_id FROM wacrm.team_members tm
      WHERE tm.team_id IN (SELECT wacrm.current_user_team_ids())
    )
$$;
REVOKE ALL ON FUNCTION wacrm.report_sees_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.report_sees_user(uuid) TO authenticated, service_role;

DO $$
DECLARE
  r record;
  v_def text;
  v_new text;
  v_guard constant text := 'AND is_account_member(p_account_id)';
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('wacrm.get_attendance_report_by_team(uuid, timestamptz, timestamptz)',
       'AND wacrm.report_sees_conversation(c.team_id, c.assigned_agent_id)'),
    ('wacrm.get_attendance_report_by_agent(uuid, timestamptz, timestamptz)',
       'AND wacrm.report_sees_conversation(c.team_id, c.assigned_agent_id)'),
    ('wacrm.get_attendance_summary(uuid, timestamptz, timestamptz)',
       'AND wacrm.report_sees_conversation(c.team_id, c.assigned_agent_id)'),
    ('wacrm.get_conversations_report(uuid, timestamptz, timestamptz, text, text, uuid, uuid, text, text, integer, integer)',
       'AND wacrm.report_sees_conversation(c.team_id, c.assigned_agent_id)'),
    ('wacrm.get_agent_sessions_report(uuid, timestamptz, timestamptz, uuid)',
       'AND wacrm.report_sees_user(s.user_id)')
  ) AS v(sig, filter)
  LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'Função % não encontrada — conferir o schema live', r.sig;
    END IF;
    v_def := pg_get_functiondef(to_regprocedure(r.sig));
    IF position('report_sees_' IN v_def) > 0 THEN
      RAISE NOTICE '% já tem o filtro do supervisor, pulando', r.sig;
      CONTINUE;
    END IF;
    IF (length(v_def) - length(replace(v_def, v_guard, ''))) / length(v_guard) <> 1 THEN
      RAISE EXCEPTION 'Definição de % diferente da esperada (guard "%" não aparece exatamente 1 vez) — nada foi alterado', r.sig, v_guard;
    END IF;
    v_new := replace(v_def, v_guard, v_guard || E'\n      ' || r.filter);
    EXECUTE v_new;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
