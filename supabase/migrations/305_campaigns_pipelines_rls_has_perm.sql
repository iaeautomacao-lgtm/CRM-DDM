-- ============================================================
-- 305_campaigns_pipelines_rls_has_perm.sql   (RLS fase 2, §8 item 4 — leitura de campanhas e funis pelo catálogo; equivalência EXATA nos papéis de sistema)
--
-- Hoje as policies de SELECT de campanhas e de funis só perguntam "é membro da conta?" (`is_account_member(account_id)`): qualquer papel, inclusive o
-- visualizador, lê. Com as chaves de leitura da 304 (dadas a TODOS os papéis, sistema e personalizados já existentes), acrescentar
-- `AND (SELECT wacrm.has_perm('<chave>'))` NÃO muda o que papel nenhum lê hoje. O que muda: um papel personalizado criado DEPOIS só lê se tiver a chave.
--   campaigns.view  → campaigns, campaign_metrics (a view campaign_metrics_live é security_invoker e herda), disp_message_queue
--   pipelines.view  → pipelines, pipeline_stages, deals
-- A expressão antiga é MANTIDA; o termo de permissão entra como `(SELECT …)` (initplan: uma avaliação por consulta, não por linha — padrão da 220/323).
--
-- FORA desta migration: `blacklist` (opt-out: regra de negócio) e `disparador_utm_links` (policy FOR ALL, escrita junto) ficam como estão. Policies FOR ALL
-- (ex.: pipeline_stages_modify, só admin) continuam valendo para o admin: o OR de policies permissivas não é alterado.
--
-- SEGURANÇA DA TROCA: has_perm é fail-closed (perfil sem role_id = false). Se houver QUALQUER perfil sem role_id, ABORTA sem alterar nada. Se uma das chaves
-- da 304 faltar no catálogo, ABORTA (aplique a 304 antes). Se a expressão VIVA de alguma policy não mencionar is_account_member (schema editado à mão), ABORTA.
--
-- DICA (aborta com "perfil(is) sem role_id"?): rode ANTES o SQL de conferência do Sextante, prd-v2/rls-p0.sql — [1] conta os perfis sem role_id (esperado 0) e
-- [2] lista os perfis cujo role_id não bate com o account_role. Para listar quem é: SELECT user_id, account_id, account_role FROM wacrm.profiles WHERE role_id IS NULL;
-- Corrija pelo backfill da 240: a trigger profiles_sync_role (BEFORE INSERT OR UPDATE) preenche o role_id a partir do account_role — um UPDATE sem mudança de valor (UPDATE wacrm.profiles SET account_role = account_role WHERE role_id IS NULL;) a dispara. Rode a 305 de novo.
--
-- PRÉ-CHECK:  SELECT count(*) FROM wacrm.profiles WHERE role_id IS NULL;                                                         -- 0
--             SELECT key FROM wacrm.permission_catalog WHERE key IN ('campaigns.view', 'pipelines.view');                          -- 2 linhas (304)
--             SELECT tablename, policyname, qual FROM pg_policies WHERE schemaname = 'wacrm' AND policyname IN
--               ('campaigns_select','campaign_metrics_select','disp_message_queue_select','pipelines_select','pipeline_stages_select','deals_select');  -- só is_account_member
-- VERIFICAÇÃO (logado como visualizador, que hoje lê): SELECT count(*) FROM wacrm.campaigns; SELECT count(*) FROM wacrm.deals;   → iguais a antes.
-- ORDEM: depois da 240, 241 e 304. Antes ou depois do deploy (o app não depende dela). Idempotente.
-- ROLLBACK:   BEGIN;
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
--             DELETE FROM wacrm.schema_migrations WHERE version = '305_campaigns_pipelines_rls_has_perm';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_orphans integer;
  r record;
  v_qual text;
BEGIN
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '305: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  IF (SELECT count(*) FROM wacrm.permission_catalog WHERE key IN ('campaigns.view', 'pipelines.view')) <> 2 THEN
    RAISE EXCEPTION '305: campaigns.view/pipelines.view fora do catálogo — aplique a 304 antes';
  END IF;
  SELECT count(*) INTO v_orphans FROM wacrm.profiles WHERE role_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '305: % perfil(is) sem role_id perderiam as leituras (has_perm é fail-closed) — preencha o role_id antes (migration 240/trigger profiles_sync_role). Nada foi alterado.', v_orphans;
  END IF;
  FOR r IN SELECT * FROM (VALUES
    ('campaigns', 'campaigns_select'), ('campaign_metrics', 'campaign_metrics_select'), ('disp_message_queue', 'disp_message_queue_select'),
    ('pipelines', 'pipelines_select'), ('pipeline_stages', 'pipeline_stages_select'), ('deals', 'deals_select')
  ) AS v(tbl, pol)
  LOOP
    IF to_regclass('wacrm.' || r.tbl) IS NULL THEN
      RAISE EXCEPTION '305: falta wacrm.% — confira o schema vivo', r.tbl;
    END IF;
    SELECT qual INTO v_qual FROM pg_policies WHERE schemaname = 'wacrm' AND tablename = r.tbl AND policyname = r.pol;
    IF v_qual IS NULL THEN
      RAISE EXCEPTION '305: a policy % não existe em wacrm.% — confira o schema vivo (nada foi alterado)', r.pol, r.tbl;
    END IF;
    IF v_qual NOT ILIKE '%has_perm%' AND v_qual NOT ILIKE '%is_account_member%' THEN
      RAISE EXCEPTION '305: a policy % tem uma expressão inesperada (%) — nada foi alterado', r.pol, v_qual;
    END IF;
  END LOOP;
END $$;

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
    INSERT INTO wacrm.schema_migrations (version) VALUES ('305_campaigns_pipelines_rls_has_perm') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
