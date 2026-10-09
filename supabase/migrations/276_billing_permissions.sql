-- ============================================================
-- 276_billing_permissions.sql   (PRD 17, PR 17.5 — permissões da régua de cobrança no catálogo e nos papéis de sistema)
--
-- Decisão do dono (PRD 17): `billing.view` = supervisor para cima; `billing.manage` = admin para cima (proprietário inclusive).
--   billing.view    ver réguas, etapas, inscrições, métricas   → owner, admin, supervisor
--   billing.manage  criar/alterar régua e etapas, simular, pausar/retomar/parar inscrição   → owner, admin   (depende de billing.view)
-- Mesmo seed de src/lib/auth/permissions.ts (o teste roles-foundation.sql.test.ts confere catálogo e papéis contra o código).
-- Papel PERSONALIZADO: ambas são concedíveis (não são owner_only); a dependência billing.manage → billing.view é validada ao salvar o papel.
-- Sem esta migration as rotas /api/billing/* respondem 403 para todos (a permissão não está em nenhum papel no banco) — nunca abrem sozinhas.
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.permission_catalog'), to_regclass('wacrm.role_permissions'), to_regclass('wacrm.account_roles');  -- não nulos (240)
--             SELECT key FROM wacrm.permission_catalog WHERE key LIKE 'billing.%';                                                         -- 0 linhas na 1ª vez
-- ORDEM: antes ou depois do deploy. Idempotente.
-- ROLLBACK:   BEGIN; DELETE FROM wacrm.role_permissions WHERE permission IN ('billing.view', 'billing.manage');
--             DELETE FROM wacrm.permission_catalog WHERE key IN ('billing.view', 'billing.manage');
--             DELETE FROM wacrm.schema_migrations WHERE version = '276_billing_permissions'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.permission_catalog') IS NULL OR to_regclass('wacrm.role_permissions') IS NULL OR to_regclass('wacrm.account_roles') IS NULL THEN
    RAISE EXCEPTION '276: faltam as tabelas de papéis (migration 240) — aplique a 240 e a 241 antes';
  END IF;
END $$;

INSERT INTO wacrm.permission_catalog (key, label, description, group_name, scope, owner_only, grantable, depends_on, sort) VALUES
  ('billing.view', 'Ver a régua de cobrança', 'Ver réguas, etapas, inscrições e métricas da régua de cobrança.', 'Cobrança', 'account', false, true, '{}'::text[], 640),
  ('billing.manage', 'Gerir a régua de cobrança', 'Criar e alterar réguas e etapas, simular, pausar e parar inscrições.', 'Cobrança', 'n/a', false, true, ARRAY['billing.view']::text[], 650)
ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label, description = EXCLUDED.description, group_name = EXCLUDED.group_name,
  scope = EXCLUDED.scope, owner_only = EXCLUDED.owner_only, grantable = EXCLUDED.grantable, depends_on = EXCLUDED.depends_on, sort = EXCLUDED.sort;

INSERT INTO wacrm.role_permissions (role_id, permission)
SELECT r.id, p.permission
  FROM wacrm.account_roles r
  JOIN (VALUES ('owner', 'billing.view'), ('owner', 'billing.manage'), ('admin', 'billing.view'), ('admin', 'billing.manage'), ('supervisor', 'billing.view'))
       AS p(role_key, permission) ON p.role_key = r.key
 WHERE r.account_id IS NULL
ON CONFLICT (role_id, permission) DO NOTHING;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('276_billing_permissions') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
