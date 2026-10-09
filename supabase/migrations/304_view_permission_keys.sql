-- ============================================================
-- 304_view_permission_keys.sql   (RLS fase 2, §8 item 4 — chaves de LEITURA campaigns.view e pipelines.view no catálogo; nada muda para ninguém)
--
-- Decisão do dono (09/10): criar chaves de leitura NOVAS e dá-las a TODOS os papéis (os de sistema e os personalizados que já existem), para que a leitura de
-- campanhas e de funis possa passar a perguntar o catálogo (migration 305) sem mudar o que ninguém lê hoje.
--   campaigns.view  Ver campanhas — campaigns, métricas e fila de envio (o Inbox do operador lê campaigns para mostrar a origem da conversa)
--   pipelines.view  Ver funis e negócios — pipelines, etapas e deals
-- (sort 660/670: no fim do catálogo, na ordem do código — o teste confere sort = posição × 10.)
-- Mesmo seed de src/lib/auth/permissions.ts (o teste roles-foundation.sql.test.ts confere catálogo e papéis de sistema contra o código: ALL = owner, admin,
-- supervisor, agent, viewer). campaigns.manage passa a depender de campaigns.view e pipelines.manage de pipelines.view (o editor de papéis exige a leitura
-- junto da gestão). Esta migration NÃO muda nenhuma policy: sozinha, é inócua (ninguém lê diferente). As policies ficam na 305.
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.permission_catalog'), to_regclass('wacrm.role_permissions'), to_regclass('wacrm.account_roles');   -- não nulos (240)
--             SELECT key FROM wacrm.permission_catalog WHERE key IN ('campaigns.view', 'pipelines.view');                                    -- 0 linhas na 1ª vez
-- ORDEM: depois da 240/241 e ANTES da 305. Antes ou depois do deploy. Idempotente.
-- ROLLBACK:   BEGIN;
--             DELETE FROM wacrm.role_permissions WHERE permission IN ('campaigns.view', 'pipelines.view');
--             UPDATE wacrm.permission_catalog SET depends_on = ARRAY['channels.view']::text[] WHERE key = 'campaigns.manage';
--             UPDATE wacrm.permission_catalog SET depends_on = '{}'::text[] WHERE key = 'pipelines.manage';
--             DELETE FROM wacrm.permission_catalog WHERE key IN ('campaigns.view', 'pipelines.view');
--             DELETE FROM wacrm.schema_migrations WHERE version = '304_view_permission_keys';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.permission_catalog') IS NULL OR to_regclass('wacrm.role_permissions') IS NULL OR to_regclass('wacrm.account_roles') IS NULL THEN
    RAISE EXCEPTION '304: faltam as tabelas de papéis (migration 240)';
  END IF;
END $$;

INSERT INTO wacrm.permission_catalog (key, label, description, group_name, scope, owner_only, grantable, depends_on, sort) VALUES
  ('pipelines.view', 'Ver funis e negócios', 'Ler funis, etapas e negócios (leitura direta do CRM).', 'Leitura de campanhas e funis', 'account', false, true, '{}'::text[], 670),
  ('campaigns.view', 'Ver campanhas', 'Ler campanhas, métricas e fila de envio (leitura direta; o Inbox mostra a origem da conversa).', 'Leitura de campanhas e funis', 'account', false, true, '{}'::text[], 660)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, group_name = EXCLUDED.group_name,
  scope = EXCLUDED.scope, owner_only = EXCLUDED.owner_only, grantable = EXCLUDED.grantable, depends_on = EXCLUDED.depends_on, sort = EXCLUDED.sort;

UPDATE wacrm.permission_catalog SET depends_on = ARRAY['channels.view', 'campaigns.view']::text[] WHERE key = 'campaigns.manage';
UPDATE wacrm.permission_catalog SET depends_on = ARRAY['pipelines.view']::text[] WHERE key = 'pipelines.manage';

-- TODOS os papéis (sistema e personalizados já existentes) ganham as duas chaves de leitura
INSERT INTO wacrm.role_permissions (role_id, permission)
SELECT r.id, k.permission
  FROM wacrm.account_roles r
 CROSS JOIN (VALUES ('campaigns.view'), ('pipelines.view')) AS k(permission)
ON CONFLICT (role_id, permission) DO NOTHING;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('304_view_permission_keys') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
