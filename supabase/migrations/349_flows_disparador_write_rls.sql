-- ============================================================
-- 349_flows_disparador_write_rls.sql   (revisão de segurança 13/10, item 8 — RLS fase 3, escrita: fluxos, automações, envios em lote e disparador)
--
-- Hoje qualquer operador (papel >= agent) grava, altera e apaga direto pelo PostgREST: fluxos, automações, campanhas/fila, métricas, blacklist, templates e links UTM.
-- Confirmado em src/ (mapeamento de quem grava pelo navegador ou por cliente de usuário):
--   O NAVEGADOR NÃO GRAVA em flows, flow_nodes, automations, automation_steps, broadcasts, broadcast_recipients, disp_message_queue, campaign_metrics:
--   as telas salvam por /api/* (service_role, com requirePermission) e o disparador/motor/webhooks usam service_role.
--   → DROP das policies de escrita + REVOKE INSERT/UPDATE/DELETE de authenticated e anon. A leitura segue pelas policies *_select (as FOR ALL *_modify também liam por papel: leitura continua igual, pelas *_select).
--   O navegador GRAVA em blacklist, disparador_message_templates e disparador_utm_links → policy com has_perm (mesma regra de conta):
--     blacklist                      campaigns.manage OU reports.view_team   (página de blacklist do disparador e botão "adicionar à blacklist" do relatório de envio em lote: admin+ e supervisor+)
--     disparador_message_templates   campaigns.manage OU templates.manage    (seletor de templates do assistente de campanha: admin+)
--     disparador_utm_links           campaigns.manage                        (assistente de campanha: admin+). A policy FOR ALL por membro (170) vira SELECT por membro + INSERT/UPDATE/DELETE com a chave:
--                                                                            até hoje um VISUALIZADOR gravava links UTM.
--   Efeito nos papéis de sistema: quem não tem a tela deixa de poder gravar por fora dela (o operador/agent perde a escrita direta de blacklist/templates/UTM e de tudo acima); admin e proprietário
--   — e o supervisor no blacklist do relatório — seguem iguais. Servidor (service_role) não passa por RLS.
--
-- SEGURANÇA DA TROCA: has_perm é fail-closed (perfil sem role_id = false) → ABORTA, sem alterar nada, se houver perfil sem role_id.
--
-- PRÉ-CHECK:  SELECT count(*) FROM wacrm.profiles WHERE role_id IS NULL;                                                                  -- 0 (senão aborta)
--             SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'wacrm' AND tablename IN ('flows','flow_nodes','automations','automation_steps','broadcasts','broadcast_recipients','disp_message_queue','campaign_metrics','blacklist','disparador_message_templates','disparador_utm_links') AND cmd <> 'SELECT' ORDER BY 1,2;
--             SELECT key FROM wacrm.permission_catalog WHERE key IN ('campaigns.manage','reports.view_team','templates.manage');         -- 3 linhas
-- VERIFICAÇÃO: como admin: criar campanha, adicionar número à blacklist, salvar fluxo e automação pelo CRM funciona; como operador, INSERT direto em wacrm.flows → "permission denied".
-- ORDEM: antes ou depois do deploy (o app não grava essas tabelas pelo navegador, exceto blacklist/templates/UTM, que continuam permitidos a quem tem a tela). Idempotente.
-- ROLLBACK:   BEGIN;
--             GRANT INSERT, UPDATE, DELETE ON wacrm.flows, wacrm.flow_nodes, wacrm.automations, wacrm.automation_steps, wacrm.broadcasts, wacrm.broadcast_recipients, wacrm.disp_message_queue, wacrm.campaign_metrics TO authenticated;
--             DROP POLICY IF EXISTS flows_insert ON wacrm.flows;
--             DROP POLICY IF EXISTS flows_update ON wacrm.flows;
--             DROP POLICY IF EXISTS flows_delete ON wacrm.flows;
--             CREATE POLICY flows_insert ON wacrm.flows FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY flows_update ON wacrm.flows FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY flows_delete ON wacrm.flows FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));
--             DROP POLICY IF EXISTS flow_nodes_modify ON wacrm.flow_nodes;
--             CREATE POLICY flow_nodes_modify ON wacrm.flow_nodes FOR ALL USING (EXISTS (SELECT 1 FROM wacrm.flows f WHERE f.id = flow_nodes.flow_id AND wacrm.is_account_member(f.account_id, 'agent'))) WITH CHECK (EXISTS (SELECT 1 FROM wacrm.flows f WHERE f.id = flow_nodes.flow_id AND wacrm.is_account_member(f.account_id, 'agent')));
--             DROP POLICY IF EXISTS automations_insert ON wacrm.automations;
--             DROP POLICY IF EXISTS automations_update ON wacrm.automations;
--             DROP POLICY IF EXISTS automations_delete ON wacrm.automations;
--             CREATE POLICY automations_insert ON wacrm.automations FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY automations_update ON wacrm.automations FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY automations_delete ON wacrm.automations FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));
--             DROP POLICY IF EXISTS automation_steps_modify ON wacrm.automation_steps;
--             CREATE POLICY automation_steps_modify ON wacrm.automation_steps FOR ALL USING (EXISTS (SELECT 1 FROM wacrm.automations a WHERE a.id = automation_steps.automation_id AND wacrm.is_account_member(a.account_id, 'agent'))) WITH CHECK (EXISTS (SELECT 1 FROM wacrm.automations a WHERE a.id = automation_steps.automation_id AND wacrm.is_account_member(a.account_id, 'agent')));
--             DROP POLICY IF EXISTS broadcasts_insert ON wacrm.broadcasts;
--             DROP POLICY IF EXISTS broadcasts_update ON wacrm.broadcasts;
--             DROP POLICY IF EXISTS broadcasts_delete ON wacrm.broadcasts;
--             CREATE POLICY broadcasts_insert ON wacrm.broadcasts FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY broadcasts_update ON wacrm.broadcasts FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY broadcasts_delete ON wacrm.broadcasts FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));
--             DROP POLICY IF EXISTS broadcast_recipients_modify ON wacrm.broadcast_recipients;
--             CREATE POLICY broadcast_recipients_modify ON wacrm.broadcast_recipients FOR ALL USING (EXISTS (SELECT 1 FROM wacrm.broadcasts b WHERE b.id = broadcast_recipients.broadcast_id AND wacrm.is_account_member(b.account_id, 'agent'))) WITH CHECK (EXISTS (SELECT 1 FROM wacrm.broadcasts b WHERE b.id = broadcast_recipients.broadcast_id AND wacrm.is_account_member(b.account_id, 'agent')));
--             DROP POLICY IF EXISTS disp_message_queue_insert ON wacrm.disp_message_queue;
--             DROP POLICY IF EXISTS disp_message_queue_update ON wacrm.disp_message_queue;
--             DROP POLICY IF EXISTS disp_message_queue_delete ON wacrm.disp_message_queue;
--             CREATE POLICY disp_message_queue_insert ON wacrm.disp_message_queue FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY disp_message_queue_update ON wacrm.disp_message_queue FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY disp_message_queue_delete ON wacrm.disp_message_queue FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));
--             DROP POLICY IF EXISTS campaign_metrics_insert ON wacrm.campaign_metrics;
--             DROP POLICY IF EXISTS campaign_metrics_update ON wacrm.campaign_metrics;
--             DROP POLICY IF EXISTS campaign_metrics_delete ON wacrm.campaign_metrics;
--             CREATE POLICY campaign_metrics_insert ON wacrm.campaign_metrics FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY campaign_metrics_update ON wacrm.campaign_metrics FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY campaign_metrics_delete ON wacrm.campaign_metrics FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));
--             DROP POLICY IF EXISTS blacklist_insert ON wacrm.blacklist;
--             DROP POLICY IF EXISTS blacklist_update ON wacrm.blacklist;
--             DROP POLICY IF EXISTS blacklist_delete ON wacrm.blacklist;
--             CREATE POLICY blacklist_insert ON wacrm.blacklist FOR INSERT WITH CHECK (account_id IS NOT NULL AND wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY blacklist_update ON wacrm.blacklist FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY blacklist_delete ON wacrm.blacklist FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));
--             DROP POLICY IF EXISTS disparador_message_templates_insert ON wacrm.disparador_message_templates;
--             DROP POLICY IF EXISTS disparador_message_templates_update ON wacrm.disparador_message_templates;
--             DROP POLICY IF EXISTS disparador_message_templates_delete ON wacrm.disparador_message_templates;
--             CREATE POLICY disparador_message_templates_insert ON wacrm.disparador_message_templates FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY disparador_message_templates_update ON wacrm.disparador_message_templates FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY disparador_message_templates_delete ON wacrm.disparador_message_templates FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));
--             DROP POLICY IF EXISTS disparador_utm_links_select ON wacrm.disparador_utm_links;
--             DROP POLICY IF EXISTS disparador_utm_links_insert ON wacrm.disparador_utm_links;
--             DROP POLICY IF EXISTS disparador_utm_links_update ON wacrm.disparador_utm_links;
--             DROP POLICY IF EXISTS disparador_utm_links_delete ON wacrm.disparador_utm_links;
--             DROP POLICY IF EXISTS disparador_utm_links_all ON wacrm.disparador_utm_links;
--             CREATE POLICY disparador_utm_links_all ON wacrm.disparador_utm_links FOR ALL TO authenticated USING (wacrm.is_account_member(account_id)) WITH CHECK (wacrm.is_account_member(account_id));
--             DELETE FROM wacrm.schema_migrations WHERE version = '349_flows_disparador_write_rls';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_orphans integer;
  t text;
BEGIN
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '349: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  IF (SELECT count(*) FROM wacrm.permission_catalog WHERE key IN ('campaigns.manage', 'reports.view_team', 'templates.manage')) <> 3 THEN
    RAISE EXCEPTION '349: faltam chaves no catálogo (campaigns.manage, reports.view_team, templates.manage — migration 240)';
  END IF;
  FOREACH t IN ARRAY ARRAY['flows', 'flow_nodes', 'automations', 'automation_steps', 'broadcasts', 'broadcast_recipients', 'disp_message_queue', 'campaign_metrics', 'blacklist', 'disparador_message_templates', 'disparador_utm_links'] LOOP
    IF to_regclass('wacrm.' || t) IS NULL THEN
      RAISE EXCEPTION '349: falta wacrm.% — confira o schema vivo', t;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_orphans FROM wacrm.profiles WHERE role_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '349: % perfil(is) sem role_id perderiam a escrita (has_perm é fail-closed) — preencha o role_id antes. Nada foi alterado.', v_orphans;
  END IF;
END $$;

-- ---- tabelas que o navegador NÃO grava: sem policy de escrita e sem privilégio de escrita -------------------------------------
DROP POLICY IF EXISTS flows_insert ON wacrm.flows;
DROP POLICY IF EXISTS flows_update ON wacrm.flows;
DROP POLICY IF EXISTS flows_delete ON wacrm.flows;
DROP POLICY IF EXISTS flow_nodes_modify ON wacrm.flow_nodes;
DROP POLICY IF EXISTS automations_insert ON wacrm.automations;
DROP POLICY IF EXISTS automations_update ON wacrm.automations;
DROP POLICY IF EXISTS automations_delete ON wacrm.automations;
DROP POLICY IF EXISTS automation_steps_modify ON wacrm.automation_steps;
DROP POLICY IF EXISTS broadcasts_insert ON wacrm.broadcasts;
DROP POLICY IF EXISTS broadcasts_update ON wacrm.broadcasts;
DROP POLICY IF EXISTS broadcasts_delete ON wacrm.broadcasts;
DROP POLICY IF EXISTS broadcast_recipients_modify ON wacrm.broadcast_recipients;
DROP POLICY IF EXISTS disp_message_queue_insert ON wacrm.disp_message_queue;
DROP POLICY IF EXISTS disp_message_queue_update ON wacrm.disp_message_queue;
DROP POLICY IF EXISTS disp_message_queue_delete ON wacrm.disp_message_queue;
DROP POLICY IF EXISTS campaign_metrics_insert ON wacrm.campaign_metrics;
DROP POLICY IF EXISTS campaign_metrics_update ON wacrm.campaign_metrics;
DROP POLICY IF EXISTS campaign_metrics_delete ON wacrm.campaign_metrics;
REVOKE INSERT, UPDATE, DELETE ON wacrm.flows, wacrm.flow_nodes, wacrm.automations, wacrm.automation_steps, wacrm.broadcasts, wacrm.broadcast_recipients, wacrm.disp_message_queue, wacrm.campaign_metrics FROM authenticated, anon;

-- ---- blacklist ---------------------------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS blacklist_insert ON wacrm.blacklist;
DROP POLICY IF EXISTS blacklist_update ON wacrm.blacklist;
DROP POLICY IF EXISTS blacklist_delete ON wacrm.blacklist;
CREATE POLICY blacklist_insert ON wacrm.blacklist FOR INSERT WITH CHECK (
  account_id IS NOT NULL AND wacrm.is_account_member(account_id)
  AND ((SELECT wacrm.has_perm('campaigns.manage')) OR (SELECT wacrm.has_perm('reports.view_team')))
);
CREATE POLICY blacklist_update ON wacrm.blacklist FOR UPDATE USING (
  wacrm.is_account_member(account_id) AND ((SELECT wacrm.has_perm('campaigns.manage')) OR (SELECT wacrm.has_perm('reports.view_team')))
) WITH CHECK (
  wacrm.is_account_member(account_id) AND ((SELECT wacrm.has_perm('campaigns.manage')) OR (SELECT wacrm.has_perm('reports.view_team')))
);
CREATE POLICY blacklist_delete ON wacrm.blacklist FOR DELETE USING (
  wacrm.is_account_member(account_id) AND ((SELECT wacrm.has_perm('campaigns.manage')) OR (SELECT wacrm.has_perm('reports.view_team')))
);

-- ---- templates do disparador -------------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS disparador_message_templates_insert ON wacrm.disparador_message_templates;
DROP POLICY IF EXISTS disparador_message_templates_update ON wacrm.disparador_message_templates;
DROP POLICY IF EXISTS disparador_message_templates_delete ON wacrm.disparador_message_templates;
CREATE POLICY disparador_message_templates_insert ON wacrm.disparador_message_templates FOR INSERT WITH CHECK (
  wacrm.is_account_member(account_id) AND ((SELECT wacrm.has_perm('campaigns.manage')) OR (SELECT wacrm.has_perm('templates.manage')))
);
CREATE POLICY disparador_message_templates_update ON wacrm.disparador_message_templates FOR UPDATE USING (
  wacrm.is_account_member(account_id) AND ((SELECT wacrm.has_perm('campaigns.manage')) OR (SELECT wacrm.has_perm('templates.manage')))
) WITH CHECK (
  wacrm.is_account_member(account_id) AND ((SELECT wacrm.has_perm('campaigns.manage')) OR (SELECT wacrm.has_perm('templates.manage')))
);
CREATE POLICY disparador_message_templates_delete ON wacrm.disparador_message_templates FOR DELETE USING (
  wacrm.is_account_member(account_id) AND ((SELECT wacrm.has_perm('campaigns.manage')) OR (SELECT wacrm.has_perm('templates.manage')))
);

-- ---- links UTM: a FOR ALL por membro vira SELECT por membro + escrita com campaigns.manage -------------------------------------------
DROP POLICY IF EXISTS disparador_utm_links_all ON wacrm.disparador_utm_links;
DROP POLICY IF EXISTS disparador_utm_links_select ON wacrm.disparador_utm_links;
DROP POLICY IF EXISTS disparador_utm_links_insert ON wacrm.disparador_utm_links;
DROP POLICY IF EXISTS disparador_utm_links_update ON wacrm.disparador_utm_links;
DROP POLICY IF EXISTS disparador_utm_links_delete ON wacrm.disparador_utm_links;
CREATE POLICY disparador_utm_links_select ON wacrm.disparador_utm_links FOR SELECT TO authenticated USING (wacrm.is_account_member(account_id));
CREATE POLICY disparador_utm_links_insert ON wacrm.disparador_utm_links FOR INSERT TO authenticated WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('campaigns.manage')));
CREATE POLICY disparador_utm_links_update ON wacrm.disparador_utm_links FOR UPDATE TO authenticated USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('campaigns.manage')))
  WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('campaigns.manage')));
CREATE POLICY disparador_utm_links_delete ON wacrm.disparador_utm_links FOR DELETE TO authenticated USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('campaigns.manage')));

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('349_flows_disparador_write_rls') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
