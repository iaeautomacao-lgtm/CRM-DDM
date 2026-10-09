-- ============================================================
-- 322_report_rpcs_has_perm.sql   (RLS fase 2, item C — RPCs de relatório pelo catálogo: reports.view_team / reports.view_all)
--
-- PROBLEMA (verificado nas migrations 051–054, 143, 165, 183): as RPCs de relatório são SECURITY DEFINER (ignoram a RLS) e só perguntam
-- "é membro da conta?" (`is_account_member(p_account_id)`). Resultado, chamando direto pelo PostgREST: QUALQUER papel (operador, visualizador…)
-- baixa o relatório da conta inteira, inclusive get_campaign_queue_items, que devolve itens POR CONTATO (nome/telefone). O recorte por equipe
-- do supervisor (143) existe, mas é por NOME do papel (`current_user_role() = 'supervisor'`): um papel personalizado nunca é escopado.
--
-- DECISÃO DO DONO (09/10): usar o catálogo. O recorte por equipe passa a depender da PERMISSÃO, não do nome do papel.
--   reports.view_team (supervisor+)  → pode chamar os relatórios de atendimento; vê só o que a policy de conversas dele deixaria ver
--   reports.view_all  (admin+)       → conta inteira; únicas a chamar os relatórios de envio em lote (campanhas e fila por contato)
--
-- O QUE FAZ
--   1. wacrm.report_can(conta, nível): membro da conta E (nível 'team': view_team OU view_all; nível 'all': view_all). Fail-closed (has_perm).
--   2. report_sees_conversation / report_sees_user (143) passam a ser "sem recorte" só para quem tem reports.view_all; quem tem apenas
--      reports.view_team é recortado pela MESMA regra da conversations_select (equipe · atribuída a ele · sem equipe com membro das equipes).
--   3. Cada RPC tem o guard trocado: `is_account_member(p_account_id)` → `(SELECT wacrm.report_can(p_account_id, '<nível>'))` (initplan: uma vez
--      por consulta, e não por linha). As funções NÃO são reescritas à mão: a definição VIVA é lida com pg_get_functiondef e o guard é trocado
--      pelo número EXATO de ocorrências esperado; se divergir, a migration aborta sem alterar nada (mesmo critério da 143). Rodar de novo é seguro.
--        nível 'team': get_attendance_report_by_team, get_attendance_report_by_agent, get_attendance_summary, get_conversations_report,
--                      get_agent_sessions_report, report_tabulacoes
--        nível 'all' : get_campaigns_for_report, get_campaign_report_detail, get_campaign_queue_items
--
-- NAS TELAS, PARA OS PAPÉIS DE SISTEMA: nada muda. /relatorios/{atendimentos,conversas,tabulacoes,agentes} = owner/admin/supervisor (todos têm
-- reports.view_team; supervisor continua recortado, owner/admin sem recorte); envio em lote = owner/admin (têm reports.view_all). Muda só a
-- chamada direta fora da UI: operador e visualizador (que não têm tela de relatório) e o supervisor nos relatórios de envio em lote deixam de receber dados.
--
-- PRÉ-CHECK:  SELECT to_regprocedure('wacrm.has_perm(text)'), to_regprocedure('wacrm.report_sees_conversation(uuid,uuid)'), to_regprocedure('wacrm.report_sees_user(uuid)');  -- não nulos (241, 143)
--             SELECT key FROM wacrm.permission_catalog WHERE key IN ('reports.view_team','reports.view_all');                                                              -- 2 linhas (240)
--             SELECT proname, (length(pg_get_functiondef(oid)) - length(regexp_replace(pg_get_functiondef(oid), 'is_account_member\(p_account_id\)', '', 'g'))) / length('is_account_member(p_account_id)') AS guards
--               FROM pg_proc WHERE pronamespace = 'wacrm'::regnamespace AND proname IN ('get_attendance_summary','report_tabulacoes','get_campaign_queue_items');   -- 1, 2 e 1
-- ORDEM: depois da 143, 165 e 241. Antes ou depois do deploy (o app não depende dela). Idempotente.
-- ROLLBACK:   BEGIN;
--             DO $$
--             DECLARE r text; d text;
--             BEGIN
--             FOREACH r IN ARRAY ARRAY['wacrm.get_attendance_report_by_team(uuid, timestamptz, timestamptz)', 'wacrm.get_attendance_report_by_agent(uuid, timestamptz, timestamptz)', 'wacrm.get_attendance_summary(uuid, timestamptz, timestamptz)', 'wacrm.get_conversations_report(uuid, timestamptz, timestamptz, text, text, uuid, uuid, text, text, integer, integer)', 'wacrm.get_agent_sessions_report(uuid, timestamptz, timestamptz, uuid)', 'wacrm.report_tabulacoes(uuid, timestamptz, timestamptz, uuid, uuid)', 'wacrm.get_campaigns_for_report(uuid)', 'wacrm.get_campaign_report_detail(uuid, uuid)', 'wacrm.get_campaign_queue_items(uuid, uuid, text, text, integer, integer)'] LOOP
--             d := pg_get_functiondef(to_regprocedure(r));
--             d := replace(replace(d, '(SELECT wacrm.report_can(p_account_id, ''team''))', 'wacrm.is_account_member(p_account_id)'), '(SELECT wacrm.report_can(p_account_id, ''all''))', 'wacrm.is_account_member(p_account_id)');
--             EXECUTE d;
--             END LOOP;
--             END $$;
--             CREATE OR REPLACE FUNCTION wacrm.report_sees_conversation(p_team uuid, p_agent uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT coalesce(wacrm.current_user_role(), '') <> 'supervisor' OR p_team IN (SELECT wacrm.current_user_team_ids()) OR p_agent = auth.uid() OR (p_team IS NULL AND p_agent IN (SELECT tm.user_id FROM wacrm.team_members tm WHERE tm.team_id IN (SELECT wacrm.current_user_team_ids()))) $$;
--             CREATE OR REPLACE FUNCTION wacrm.report_sees_user(p_user uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT coalesce(wacrm.current_user_role(), '') <> 'supervisor' OR p_user = auth.uid() OR p_user IN (SELECT tm.user_id FROM wacrm.team_members tm WHERE tm.team_id IN (SELECT wacrm.current_user_team_ids())) $$;
--             DROP FUNCTION IF EXISTS wacrm.report_can(uuid, text);
--             DELETE FROM wacrm.schema_migrations WHERE version = '322_report_rpcs_has_perm';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '322: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  IF to_regprocedure('wacrm.report_sees_conversation(uuid, uuid)') IS NULL OR to_regprocedure('wacrm.report_sees_user(uuid)') IS NULL THEN
    RAISE EXCEPTION '322: faltam report_sees_conversation/report_sees_user (migration 143)';
  END IF;
  IF to_regprocedure('wacrm.current_user_team_ids()') IS NULL THEN
    RAISE EXCEPTION '322: falta wacrm.current_user_team_ids() (migration 140)';
  END IF;
  IF (SELECT count(*) FROM wacrm.permission_catalog WHERE key IN ('reports.view_team', 'reports.view_all')) <> 2 THEN
    RAISE EXCEPTION '322: reports.view_team/reports.view_all fora do catálogo (migration 240)';
  END IF;
END $$;

-- 1) acesso ao relatório: membro da conta + permissão do nível
CREATE OR REPLACE FUNCTION wacrm.report_can(p_account uuid, p_level text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT wacrm.is_account_member(p_account)
     AND (
       wacrm.has_perm('reports.view_all')
       OR (p_level = 'team' AND wacrm.has_perm('reports.view_team'))
     )
$$;
REVOKE ALL ON FUNCTION wacrm.report_can(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.report_can(uuid, text) TO authenticated, service_role;

-- 2) recorte por equipe: por PERMISSÃO (sem reports.view_all ⇒ só o que a equipe dele enxerga), não pelo nome do papel
CREATE OR REPLACE FUNCTION wacrm.report_sees_conversation(p_team uuid, p_agent uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT wacrm.has_perm('reports.view_all')
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
  SELECT wacrm.has_perm('reports.view_all')
    OR p_user = auth.uid()
    OR p_user IN (
      SELECT tm.user_id FROM wacrm.team_members tm
      WHERE tm.team_id IN (SELECT wacrm.current_user_team_ids())
    )
$$;
REVOKE ALL ON FUNCTION wacrm.report_sees_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.report_sees_user(uuid) TO authenticated, service_role;

-- 3) guard das RPCs (definição viva; número exato de ocorrências ou aborta sem alterar nada)
DO $$
DECLARE
  r record;
  v_def text;
  v_new text;
  v_found integer;
  v_re constant text := '(wacrm\.)?is_account_member\(p_account_id\)';
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('wacrm.get_attendance_report_by_team(uuid, timestamptz, timestamptz)', 'team', 1),
    ('wacrm.get_attendance_report_by_agent(uuid, timestamptz, timestamptz)', 'team', 1),
    ('wacrm.get_attendance_summary(uuid, timestamptz, timestamptz)', 'team', 1),
    ('wacrm.get_conversations_report(uuid, timestamptz, timestamptz, text, text, uuid, uuid, text, text, integer, integer)', 'team', 1),
    ('wacrm.get_agent_sessions_report(uuid, timestamptz, timestamptz, uuid)', 'team', 1),
    ('wacrm.report_tabulacoes(uuid, timestamptz, timestamptz, uuid, uuid)', 'team', 2),
    ('wacrm.get_campaigns_for_report(uuid)', 'all', 1),
    ('wacrm.get_campaign_report_detail(uuid, uuid)', 'all', 1),
    ('wacrm.get_campaign_queue_items(uuid, uuid, text, text, integer, integer)', 'all', 1)
  ) AS v(sig, lvl, expected)
  LOOP
    IF to_regprocedure(r.sig) IS NULL THEN
      RAISE EXCEPTION 'Função % não encontrada — conferir o schema live', r.sig;
    END IF;
    v_def := pg_get_functiondef(to_regprocedure(r.sig));
    IF position('report_can(' IN v_def) > 0 THEN
      RAISE NOTICE '% já usa report_can, pulando', r.sig;
      CONTINUE;
    END IF;
    SELECT count(*) INTO v_found FROM regexp_matches(v_def, v_re, 'g');
    IF v_found <> r.expected THEN
      RAISE EXCEPTION 'Definição de % diferente da esperada (guard aparece % vez(es), esperado %) — nada foi alterado', r.sig, v_found, r.expected;
    END IF;
    v_new := regexp_replace(v_def, v_re, format('(SELECT wacrm.report_can(p_account_id, %L))', r.lvl), 'g');
    EXECUTE v_new;
  END LOOP;
END;
$$;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('322_report_rpcs_has_perm') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
