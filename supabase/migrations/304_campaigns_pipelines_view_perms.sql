-- ============================================================
-- 304_campaigns_pipelines_view_perms.sql   (RLS fase 2, §8 item 4 — chaves de LEITURA campaigns.view e pipelines.view; nada muda nos papéis de sistema)
--
-- Hoje as policies de SELECT de campanhas e de funis só perguntam "é membro da conta?": qualquer papel, inclusive o visualizador, lê. A chave de gestão
-- (campaigns.manage / pipelines.manage) é admin+ e o Inbox do operador LÊ campaigns (origem da conversa), então não dá para usá-la na leitura.
-- Decisão do dono (09/10): criar chaves de leitura NOVAS, dadas a TODOS os papéis (sistema e personalizados já existentes), e trocar as policies de SELECT
-- para `is_account_member(...) AND (SELECT wacrm.has_perm('<chave>'))` (initplan: uma avaliação por consulta, padrão da 220/323).
--   campaigns.view  → campaigns, campaign_metrics (a view campaign_metrics_live é security_invoker e herda), disp_message_queue
--   pipelines.view  → pipelines, pipeline_stages, deals
-- Efeito: papéis de SISTEMA leem exatamente o que liam (todos têm as chaves, seed do mesmo arquivo src/lib/auth/permissions.ts). Papel PERSONALIZADO criado
-- DEPOIS só lê se tiver a chave (o editor passa a oferecê-la); os que já existem recebem as duas chaves aqui, então também não mudam hoje.
-- campaigns.manage passa a depender de campaigns.view e pipelines.manage de pipelines.view (o editor exige a leitura junto da gestão).
--
-- FORA desta migration (decisão de segurança/negócio): `blacklist` (opt-out) e `disparador_utm_links` (policy FOR ALL, escrita junto) ficam como estão.
-- Policies FOR ALL (pipeline_stages_modify) continuam valendo para quem é admin: o OR de policies permissivas não é alterado.
--
-- SEGURANÇA DA TROCA: has_perm é fail-closed (perfil sem role_id = false). Se houver QUALQUER perfil sem role_id a migration ABORTA sem alterar nada. E se a
-- expressão VIVA de alguma policy não for a esperada (não menciona is_account_member), ABORTA também (o schema vivo pode ter sido editado à mão).
--
-- PRÉ-CHECK:  SELECT count(*) FROM wacrm.profiles WHERE role_id IS NULL;                                               -- 0
--             SELECT to_regprocedure('wacrm.has_perm(text)'), to_regclass('wacrm.permission_catalog');               -- não nulos (240/241)
--             SELECT tablename, policyname, qual FROM pg_policies WHERE schemaname = 'wacrm' AND policyname IN
--               ('campaigns_select','campaign_metrics_select','disp_message_queue_select','pipelines_select','pipeline_stages_select','deals_select');  -- só is_account_member
-- VERIFICAÇÃO (logado como visualizador, que hoje lê): SELECT count(*) FROM wacrm.campaigns; SELECT count(*) FROM wacrm.deals;  → iguais a antes.
-- ORDEM: depois da 240/241. Antes ou depois do deploy (o app não depende dela; sem ela, nada muda). Idempotente.
-- ROLLBACK:   DELETE FROM wacrm.role_permissions WHERE permission IN ('campaigns.view', 'pipelines.view');
--             UPDATE wacrm.permission_catalog SET depends_on = ARRAY['channels.view']::text[] WHERE key = 'campaigns.manage';
--             UPDATE wacrm.permission_catalog SET depends_on = '{}'::text[] WHERE key = 'pipelines.manage';
--             DELETE FROM wacrm.permission_catalog WHERE key IN ('campaigns.view', 'pipelines.view');
--             DROP POLICY IF EXISTS campaigns_select ON wacrm.campaigns;
--             CREATE POLICY campaigns_select ON wacrm.campaigns FOR SELECT USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS campaign_metrics_select ON wacrm.campaign_metrics;
--             CREATE POLICY campaign_metrics_select ON wacrm.campaign_metrics FOR SELECT USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS disp_message_queue_select ON wacrm.disp_message_queue;
--             CREATE POLICY disp_message_queue_select ON wacrm.disp_message_queue FOR SELECT USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS pipelines_select ON wacrm.pipelines;
--             CREATE POLICY pipelines_select ON wacrm.pipelines FOR SELECT USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS deals_select ON wacrm.deals;
--             CREATE POLICY deals_select ON wacrm.deals FOR SELECT USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS pipeline_stages_select ON wacrm.pipeline_stages;
--             CREATE POLICY pipeline_stages_select ON wacrm.pipeline_stages FOR SELECT USING (EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = pipeline_stages.pipeline_id AND wacrm.is_account_member(p.account_id)));
--             DELETE FROM wacrm.schema_migrations WHERE version = '304_campaigns_pipelines_view_perms';
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_orphans integer;
  r record;
  v_qual text;
BEGIN
  IF to_regclass('wacrm.permission_catalog') IS NULL OR to_regclass('wacrm.role_permissions') IS NULL OR to_regclass('wacrm.account_roles') IS NULL THEN
    RAISE EXCEPTION '304: faltam as tabelas de papéis (migration 240)';
  END IF;
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '304: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  SELECT count(*) INTO v_orphans FROM wacrm.profiles WHERE role_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '304: % perfil(is) sem role_id perderiam as leituras (has_perm é fail-closed) — preencha o role_id antes (migration 240/trigger profiles_sync_role). Nada foi alterado.', v_orphans;
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('campaigns', 'campaigns_select'), ('campaign_metrics', 'campaign_metrics_select'), ('disp_message_queue', 'disp_message_queue_select'),
    ('pipelines', 'pipelines_select'), ('pipeline_stages', 'pipeline_stages_select'), ('deals', 'deals_select')
  ) AS v(tbl, pol)
  LOOP
    IF to_regclass('wacrm.' || r.tbl) IS NULL THEN
      RAISE EXCEPTION '304: falta wacrm.% — confira o schema vivo', r.tbl;
    END IF;
    SELECT qual INTO v_qual FROM pg_policies WHERE schemaname = 'wacrm' AND tablename = r.tbl AND policyname = r.pol;
    IF v_qual IS NULL THEN
      RAISE EXCEPTION '304: a policy % não existe em wacrm.% — confira o schema vivo (nada foi alterado)', r.pol, r.tbl;
    END IF;
    IF v_qual NOT ILIKE '%has_perm%' AND v_qual NOT ILIKE '%is_account_member%' THEN
      RAISE EXCEPTION '304: a policy % tem uma expressão inesperada (%) — nada foi alterado', r.pol, v_qual;
    END IF;
  END LOOP;
END $$;

-- 1) catálogo
INSERT INTO wacrm.permission_catalog (key, label, description, group_name, scope, owner_only, grantable, depends_on, sort) VALUES
  ('pipelines.view', 'Ver funis e negócios', 'Ler funis, etapas e negócios (leitura direta do CRM).', 'Contatos', 'account', false, true, '{}'::text[], 155),
  ('campaigns.view', 'Ver campanhas', 'Ler campanhas, métricas e fila de envio (leitura direta; o Inbox mostra a origem da conversa).', 'Disparador', 'account', false, true, '{}'::text[], 285)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, group_name = EXCLUDED.group_name,
  scope = EXCLUDED.scope, owner_only = EXCLUDED.owner_only, grantable = EXCLUDED.grantable, depends_on = EXCLUDED.depends_on, sort = EXCLUDED.sort;

UPDATE wacrm.permission_catalog SET depends_on = ARRAY['channels.view', 'campaigns.view']::text[] WHERE key = 'campaigns.manage';
UPDATE wacrm.permission_catalog SET depends_on = ARRAY['pipelines.view']::text[] WHERE key = 'pipelines.manage';

-- 2) TODOS os papéis (sistema e personalizados já existentes) ganham as duas chaves de leitura
INSERT INTO wacrm.role_permissions (role_id, permission)
SELECT r.id, k.permission
  FROM wacrm.account_roles r
 CROSS JOIN (VALUES ('campaigns.view'), ('pipelines.view')) AS k(permission)
ON CONFLICT (role_id, permission) DO NOTHING;

-- 3) policies de SELECT (a expressão antiga é mantida; o termo de permissão entra como initplan)
DROP POLICY IF EXISTS campaigns_select ON wacrm.campaigns;
CREATE POLICY campaigns_select ON wacrm.campaigns FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('campaigns.view'))
);
DROP POLICY IF EXISTS campaign_metrics_select ON wacrm.campaign_metrics;
CREATE POLICY campaign_metrics_select ON wacrm.campaign_metrics FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('campaigns.view'))
);
DROP POLICY IF EXISTS disp_message_queue_select ON wacrm.disp_message_queue;
CREATE POLICY disp_message_queue_select ON wacrm.disp_message_queue FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('campaigns.view'))
);
DROP POLICY IF EXISTS pipelines_select ON wacrm.pipelines;
CREATE POLICY pipelines_select ON wacrm.pipelines FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('pipelines.view'))
);
DROP POLICY IF EXISTS deals_select ON wacrm.deals;
CREATE POLICY deals_select ON wacrm.deals FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('pipelines.view'))
);
DROP POLICY IF EXISTS pipeline_stages_select ON wacrm.pipeline_stages;
CREATE POLICY pipeline_stages_select ON wacrm.pipeline_stages FOR SELECT USING (
  EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = pipeline_stages.pipeline_id AND wacrm.is_account_member(p.account_id))
  AND (SELECT wacrm.has_perm('pipelines.view'))
);

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('304_campaigns_pipelines_view_perms') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
