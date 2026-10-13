-- ============================================================
-- 348_deals_pipelines_write_rls_has_perm.sql   (revisão de segurança 13/10, item 8 — RLS fase 3, escrita: negócios e funis)
--
-- Escrita de negócios (deals) exigia só "papel >= agent"; funis (pipelines) e etapas (pipeline_stages) "papel >= admin" (017), com uma policy FOR ALL nas etapas.
-- Passa a decidir pelo catálogo, com a MESMA regra de conta:
--   deals                       INSERT/UPDATE/DELETE  →  contacts.edit     (agent+ nos papéis de sistema; é a chave que a tela de funis já usa para criar/mover negócio)
--   pipelines, pipeline_stages  INSERT/UPDATE/DELETE  →  pipelines.manage  (admin+ nos papéis de sistema; chave que a tela usa para configurar funis)
-- Nenhuma tela dos papéis de sistema muda. Papel PERSONALIZADO passa a escrever pelo que o catálogo diz.
-- pipeline_stages_modify (FOR ALL) vira INSERT/UPDATE/DELETE: a leitura vem só da pipeline_stages_select por permissão (305).
-- deal_aging_rules fica como está (174). Servidor (service_role) não passa por RLS.
--
-- SEGURANÇA DA TROCA: has_perm é fail-closed (perfil sem role_id = false) → ABORTA, sem alterar nada, se houver perfil sem role_id.
--
-- PRÉ-CHECK:  SELECT count(*) FROM wacrm.profiles WHERE role_id IS NULL;                                                              -- 0 (senão aborta)
--             SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'wacrm' AND tablename IN ('deals','pipelines','pipeline_stages') ORDER BY 1,2;
--             SELECT key FROM wacrm.permission_catalog WHERE key IN ('contacts.edit','pipelines.manage');                              -- 2 linhas
-- VERIFICAÇÃO: como operador: mover/criar negócio no funil funciona; como operador, INSERT em wacrm.pipelines → "violates row-level security".
-- ORDEM: antes ou depois do deploy (o app não depende dela). Idempotente.
-- ROLLBACK:   BEGIN;
--             DROP POLICY IF EXISTS deals_insert ON wacrm.deals;
--             DROP POLICY IF EXISTS deals_update ON wacrm.deals;
--             DROP POLICY IF EXISTS deals_delete ON wacrm.deals;
--             CREATE POLICY deals_insert ON wacrm.deals FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY deals_update ON wacrm.deals FOR UPDATE USING (wacrm.is_account_member(account_id, 'agent'));
--             CREATE POLICY deals_delete ON wacrm.deals FOR DELETE USING (wacrm.is_account_member(account_id, 'agent'));
--             DROP POLICY IF EXISTS pipelines_insert ON wacrm.pipelines;
--             DROP POLICY IF EXISTS pipelines_update ON wacrm.pipelines;
--             DROP POLICY IF EXISTS pipelines_delete ON wacrm.pipelines;
--             CREATE POLICY pipelines_insert ON wacrm.pipelines FOR INSERT WITH CHECK (wacrm.is_account_member(account_id, 'admin'));
--             CREATE POLICY pipelines_update ON wacrm.pipelines FOR UPDATE USING (wacrm.is_account_member(account_id, 'admin'));
--             CREATE POLICY pipelines_delete ON wacrm.pipelines FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));
--             DROP POLICY IF EXISTS pipeline_stages_insert ON wacrm.pipeline_stages;
--             DROP POLICY IF EXISTS pipeline_stages_update ON wacrm.pipeline_stages;
--             DROP POLICY IF EXISTS pipeline_stages_delete ON wacrm.pipeline_stages;
--             DROP POLICY IF EXISTS pipeline_stages_modify ON wacrm.pipeline_stages;
--             CREATE POLICY pipeline_stages_modify ON wacrm.pipeline_stages FOR ALL USING (EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = pipeline_stages.pipeline_id AND wacrm.is_account_member(p.account_id, 'admin'))) WITH CHECK (EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = pipeline_stages.pipeline_id AND wacrm.is_account_member(p.account_id, 'admin')));
--             DELETE FROM wacrm.schema_migrations WHERE version = '348_deals_pipelines_write_rls_has_perm';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_orphans integer;
  t text;
BEGIN
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '348: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  IF (SELECT count(*) FROM wacrm.permission_catalog WHERE key IN ('contacts.edit', 'pipelines.manage')) <> 2 THEN
    RAISE EXCEPTION '348: faltam chaves no catálogo (contacts.edit, pipelines.manage — migration 240)';
  END IF;
  FOREACH t IN ARRAY ARRAY['deals', 'pipelines', 'pipeline_stages'] LOOP
    IF to_regclass('wacrm.' || t) IS NULL THEN
      RAISE EXCEPTION '348: falta wacrm.% — confira o schema vivo', t;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_orphans FROM wacrm.profiles WHERE role_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '348: % perfil(is) sem role_id perderiam a escrita (has_perm é fail-closed) — preencha o role_id antes. Nada foi alterado.', v_orphans;
  END IF;
END $$;

-- ---- deals (contacts.edit) --------------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS deals_insert ON wacrm.deals;
DROP POLICY IF EXISTS deals_update ON wacrm.deals;
DROP POLICY IF EXISTS deals_delete ON wacrm.deals;
CREATE POLICY deals_insert ON wacrm.deals FOR INSERT WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.edit')));
CREATE POLICY deals_update ON wacrm.deals FOR UPDATE USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.edit')))
  WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.edit')));
CREATE POLICY deals_delete ON wacrm.deals FOR DELETE USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('contacts.edit')));

-- ---- pipelines (pipelines.manage) -------------------------------------------------------------------------------------------
DROP POLICY IF EXISTS pipelines_insert ON wacrm.pipelines;
DROP POLICY IF EXISTS pipelines_update ON wacrm.pipelines;
DROP POLICY IF EXISTS pipelines_delete ON wacrm.pipelines;
CREATE POLICY pipelines_insert ON wacrm.pipelines FOR INSERT WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('pipelines.manage')));
CREATE POLICY pipelines_update ON wacrm.pipelines FOR UPDATE USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('pipelines.manage')))
  WITH CHECK (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('pipelines.manage')));
CREATE POLICY pipelines_delete ON wacrm.pipelines FOR DELETE USING (wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('pipelines.manage')));

-- ---- pipeline_stages: a FOR ALL (que também lia por papel) vira INSERT/UPDATE/DELETE ----------------------------------------
DROP POLICY IF EXISTS pipeline_stages_modify ON wacrm.pipeline_stages;
DROP POLICY IF EXISTS pipeline_stages_insert ON wacrm.pipeline_stages;
DROP POLICY IF EXISTS pipeline_stages_update ON wacrm.pipeline_stages;
DROP POLICY IF EXISTS pipeline_stages_delete ON wacrm.pipeline_stages;
CREATE POLICY pipeline_stages_insert ON wacrm.pipeline_stages FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = pipeline_stages.pipeline_id AND wacrm.is_account_member(p.account_id)) AND (SELECT wacrm.has_perm('pipelines.manage'))
);
CREATE POLICY pipeline_stages_update ON wacrm.pipeline_stages FOR UPDATE USING (
  EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = pipeline_stages.pipeline_id AND wacrm.is_account_member(p.account_id)) AND (SELECT wacrm.has_perm('pipelines.manage'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = pipeline_stages.pipeline_id AND wacrm.is_account_member(p.account_id)) AND (SELECT wacrm.has_perm('pipelines.manage'))
);
CREATE POLICY pipeline_stages_delete ON wacrm.pipeline_stages FOR DELETE USING (
  EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = pipeline_stages.pipeline_id AND wacrm.is_account_member(p.account_id)) AND (SELECT wacrm.has_perm('pipelines.manage'))
);

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('348_deals_pipelines_write_rls_has_perm') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
