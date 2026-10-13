-- ============================================================
-- 340_pipeline_archive.sql   (decisão do dono de 13/10, item 7 — arquivamento de funil)
--
-- O QUE FAZ:
--   1. pipelines.archived_at / archived_by. Arquivar NÃO apaga nada: esconde o funil das listas e, pelo RLS, os negócios e as
--      etapas dele de listas e relatórios (as RPCs do dashboard da 293 são SECURITY INVOKER: acompanham sozinhas). O funil
--      arquivado continua legível (aba "Arquivados", para restaurar); negócios e etapas voltam ao restaurar.
--   2. wacrm.archive_pipeline(funil) e wacrm.restore_pipeline(funil): quem tem pipelines.manage na organização. SECURITY
--      DEFINER com auth.uid() (o front chama direto); auditoria pipeline.archived / pipeline.restored.
--   3. Excluir em DEFINITIVO passa a ser só do proprietário: permissão nova pipelines.delete (ownerOnly, não concedível) e a
--      policy de DELETE de pipelines pede has_perm('pipelines.delete'). Auditoria pipeline.deleted (com quantos negócios
--      foram junto — deals cai em cascata).
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.pipelines'), to_regclass('wacrm.deals'), to_regclass('wacrm.pipeline_stages');      -- não nulos
--   SELECT to_regprocedure('wacrm.has_perm(text)'), to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)');
--   SELECT key FROM wacrm.permission_catalog WHERE key IN ('pipelines.view', 'pipelines.manage', 'pipelines.delete');
--      -- pipelines.view (304) e pipelines.manage presentes; pipelines.delete ausente na 1ª vez
--   SELECT policyname, qual FROM pg_policies WHERE schemaname = 'wacrm' AND tablename IN ('pipelines', 'deals', 'pipeline_stages');
--      -- esperado: pipelines_delete (017) e os *_select da 305; outra policy permissiva de leitura continuaria mostrando arquivados
-- VERIFICAÇÃO:
--   SELECT archived_at FROM wacrm.pipelines LIMIT 1;
--   SELECT version FROM wacrm.schema_migrations WHERE version = '340_pipeline_archive';
-- ORDEM: antes ou depois do deploy (sem as RPCs o botão "Arquivar" do front falha; nada mais muda). Depois da 305. Idempotente.
-- ROLLBACK (executável: policies anteriores recriadas ANTES do DROP COLUMN, que as policies novas referenciam; trigger antes da função):
--   BEGIN;
--   UPDATE wacrm.pipelines SET archived_at = NULL, archived_by = NULL;   -- desarquiva tudo antes, senão negócios somem do RLS
--   DROP POLICY IF EXISTS deals_select ON wacrm.deals;
--   CREATE POLICY deals_select ON wacrm.deals FOR SELECT USING (
--     wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('pipelines.view'))
--   );
--   DROP POLICY IF EXISTS pipeline_stages_select ON wacrm.pipeline_stages;
--   CREATE POLICY pipeline_stages_select ON wacrm.pipeline_stages FOR SELECT USING (
--     EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = pipeline_stages.pipeline_id AND wacrm.is_account_member(p.account_id))
--     AND (SELECT wacrm.has_perm('pipelines.view'))
--   );
--   DROP POLICY IF EXISTS pipelines_delete ON wacrm.pipelines;
--   CREATE POLICY pipelines_delete ON wacrm.pipelines FOR DELETE USING (wacrm.is_account_member(account_id, 'admin'));
--   DROP TRIGGER IF EXISTS trg_audit_pipeline_deleted ON wacrm.pipelines;
--   DROP FUNCTION IF EXISTS wacrm.archive_pipeline(uuid);
--   DROP FUNCTION IF EXISTS wacrm.restore_pipeline(uuid);
--   DROP FUNCTION IF EXISTS wacrm.audit_pipeline_deleted();
--   DELETE FROM wacrm.role_permissions WHERE permission = 'pipelines.delete';
--   DELETE FROM wacrm.permission_catalog WHERE key = 'pipelines.delete';
--   ALTER TABLE wacrm.pipelines DROP COLUMN IF EXISTS archived_at, DROP COLUMN IF EXISTS archived_by;
--   DELETE FROM wacrm.schema_migrations WHERE version = '340_pipeline_archive';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.pipelines') IS NULL OR to_regclass('wacrm.deals') IS NULL OR to_regclass('wacrm.pipeline_stages') IS NULL THEN
    RAISE EXCEPTION '340: faltam wacrm.pipelines/deals/pipeline_stages';
  END IF;
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '340: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  IF to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION '340: falta wacrm.audit_write (migration 131)';
  END IF;
  IF (SELECT count(*) FROM wacrm.permission_catalog WHERE key IN ('pipelines.view', 'pipelines.manage')) <> 2 THEN
    RAISE EXCEPTION '340: pipelines.view/pipelines.manage fora do catálogo — aplique a 304 antes';
  END IF;
END $$;

-- 1. Colunas
ALTER TABLE wacrm.pipelines
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid;

-- RLS de leitura (305 + funil ativo): negócios e etapas de funil arquivado somem de listas e relatórios.
DROP POLICY IF EXISTS deals_select ON wacrm.deals;
CREATE POLICY deals_select ON wacrm.deals FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('pipelines.view'))
  AND EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = deals.pipeline_id AND p.archived_at IS NULL)
);
DROP POLICY IF EXISTS pipeline_stages_select ON wacrm.pipeline_stages;
CREATE POLICY pipeline_stages_select ON wacrm.pipeline_stages FOR SELECT USING (
  EXISTS (SELECT 1 FROM wacrm.pipelines p WHERE p.id = pipeline_stages.pipeline_id AND wacrm.is_account_member(p.account_id) AND p.archived_at IS NULL)
  AND (SELECT wacrm.has_perm('pipelines.view'))
);

-- 2. Arquivar / restaurar
CREATE OR REPLACE FUNCTION wacrm.archive_pipeline(p_pipeline uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_account uuid;
  v_name text;
  v_deals integer;
BEGIN
  SELECT p.account_id, p.name INTO v_account, v_name
    FROM wacrm.pipelines p
   WHERE p.id = p_pipeline AND p.account_id = wacrm.current_account_id()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Funil não encontrado nesta organização' USING ERRCODE = 'P0002';
  END IF;
  IF v_uid IS NULL OR NOT wacrm.has_perm('pipelines.manage') THEN
    RAISE EXCEPTION 'Você não pode arquivar funis' USING ERRCODE = '42501';
  END IF;
  UPDATE wacrm.pipelines SET archived_at = coalesce(archived_at, now()), archived_by = coalesce(archived_by, v_uid)
   WHERE id = p_pipeline;
  SELECT count(*) INTO v_deals FROM wacrm.deals d WHERE d.pipeline_id = p_pipeline;
  PERFORM wacrm.audit_write(v_account, 'action', 'pipeline', p_pipeline, v_name, 'pipeline.archived',
    format('Funil %s arquivado (%s negócio(s) ocultos)', v_name, v_deals), NULL, jsonb_build_object('deals', v_deals));
  RETURN jsonb_build_object('id', p_pipeline, 'archived', true, 'deals', v_deals);
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.restore_pipeline(p_pipeline uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_account uuid;
  v_name text;
BEGIN
  SELECT p.account_id, p.name INTO v_account, v_name
    FROM wacrm.pipelines p
   WHERE p.id = p_pipeline AND p.account_id = wacrm.current_account_id()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Funil não encontrado nesta organização' USING ERRCODE = 'P0002';
  END IF;
  IF v_uid IS NULL OR NOT wacrm.has_perm('pipelines.manage') THEN
    RAISE EXCEPTION 'Você não pode restaurar funis' USING ERRCODE = '42501';
  END IF;
  UPDATE wacrm.pipelines SET archived_at = NULL, archived_by = NULL WHERE id = p_pipeline;
  PERFORM wacrm.audit_write(v_account, 'action', 'pipeline', p_pipeline, v_name, 'pipeline.restored',
    format('Funil %s restaurado', v_name), NULL, NULL);
  RETURN jsonb_build_object('id', p_pipeline, 'archived', false);
END;
$$;
REVOKE ALL ON FUNCTION wacrm.archive_pipeline(uuid), wacrm.restore_pipeline(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.archive_pipeline(uuid), wacrm.restore_pipeline(uuid) TO authenticated, service_role;

-- 3. Excluir em definitivo: só o proprietário (pipelines.delete)
INSERT INTO wacrm.permission_catalog (key, label, description, group_name, scope, owner_only, grantable, depends_on, sort)
VALUES ('pipelines.delete', 'Excluir funil em definitivo',
        'Apagar um funil com etapas e negócios, sem volta (arquivar é o caminho normal).', 'Funis', 'n/a', true, false,
        ARRAY['pipelines.manage']::text[], 680)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, group_name = EXCLUDED.group_name,
  scope = EXCLUDED.scope, owner_only = EXCLUDED.owner_only, grantable = EXCLUDED.grantable, depends_on = EXCLUDED.depends_on,
  sort = EXCLUDED.sort;
INSERT INTO wacrm.role_permissions (role_id, permission)
SELECT r.id, 'pipelines.delete' FROM wacrm.account_roles r WHERE r.account_id IS NULL AND r.key = 'owner'
ON CONFLICT (role_id, permission) DO NOTHING;

DROP POLICY IF EXISTS pipelines_delete ON wacrm.pipelines;
CREATE POLICY pipelines_delete ON wacrm.pipelines FOR DELETE USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('pipelines.delete'))
);

CREATE OR REPLACE FUNCTION wacrm.audit_pipeline_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
BEGIN
  PERFORM wacrm.audit_write(OLD.account_id, 'deleted', 'pipeline', OLD.id, OLD.name, 'pipeline.deleted',
    format('Funil %s excluído em definitivo', OLD.name), NULL,
    jsonb_build_object('archived_at', OLD.archived_at));
  RETURN OLD;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_pipeline_deleted falhou: %', SQLERRM;   -- auditoria nunca derruba a exclusão
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.audit_pipeline_deleted() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_audit_pipeline_deleted ON wacrm.pipelines;
CREATE TRIGGER trg_audit_pipeline_deleted
  BEFORE DELETE ON wacrm.pipelines
  FOR EACH ROW EXECUTE FUNCTION wacrm.audit_pipeline_deleted();

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('340_pipeline_archive') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
