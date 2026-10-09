-- ============================================================
-- 312_custom_role_validation.sql   (PRD 20 — papel personalizado, parte 1: o que pode entrar num papel)
--
-- O catálogo do banco (240 + 276) já tem as mesmas 65 chaves de src/lib/auth/permissions.ts; esta migration NÃO mexe nos
-- papéis de sistema. O que faz:
--   1. permission_catalog.grantable passa a ser `NOT owner_only AND NOT future`: além das ownerOnly, as permissões ainda
--      sem checagem no código (`future` no TS; hoje só integrations.manage) não entram em papel personalizado.
--      O teste compara linha a linha com isGrantableToCustomRole().
--   2. wacrm.expand_permissions(text[]): espelho de expandPermissions() do TS (a variante ampla implica a estreita).
--      Os papéis de sistema já são gravados expandidos; os personalizados também serão (313), para has_perm() valer igual.
--   3. wacrm.custom_role_permission_errors(text[]): espelho de validateCustomRolePermissions() — devolve a lista de erros
--      (jsonb) com os MESMOS códigos do TS: unknown_permission, owner_only, not_grantable, missing_dependency.
--      Vazio = válido. Usada pelas RPCs da 313 (o banco é a fonte de verdade; o TS valida antes para dar 400 rápido).
--   Funções internas: só service_role (as RPCs da 313 são SECURITY DEFINER e chamam estas).
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.permission_catalog'), to_regprocedure('wacrm.compat_role_for(text[])');   -- não nulos (240/241)
--   SELECT count(*) FROM wacrm.permission_catalog;                                                      -- 65
--   SELECT key FROM wacrm.permission_catalog WHERE grantable AND owner_only;                            -- 0 linhas
-- VERIFICAÇÃO:
--   SELECT key FROM wacrm.permission_catalog WHERE NOT grantable ORDER BY 1;   -- as 6 ownerOnly + integrations.manage
--   SELECT wacrm.custom_role_permission_errors(ARRAY['inbox.reply']);           -- [{"code":"missing_dependency",...}]
-- ORDEM: antes do deploy do papel personalizado (junto com a 313). Idempotente.
-- ROLLBACK:
--   BEGIN; UPDATE wacrm.permission_catalog SET grantable = NOT owner_only;
--   DROP FUNCTION IF EXISTS wacrm.custom_role_permission_errors(text[]), wacrm.expand_permissions(text[]);
--   DELETE FROM wacrm.schema_migrations WHERE version = '312_custom_role_validation'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.permission_catalog') IS NULL OR to_regclass('wacrm.account_roles') IS NULL
     OR to_regclass('wacrm.role_permissions') IS NULL THEN
    RAISE EXCEPTION '312: faltam as tabelas de papéis (migration 240)';
  END IF;
  IF to_regprocedure('wacrm.compat_role_for(text[])') IS NULL THEN
    RAISE EXCEPTION '312: falta wacrm.compat_role_for(text[]) (migration 241)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM wacrm.permission_catalog WHERE key = 'integrations.manage') THEN
    RAISE EXCEPTION '312: catálogo sem integrations.manage — confira o seed da 240 no schema vivo';
  END IF;
END $$;

-- 1. Teto: ownerOnly e `future` (sem checagem no código) não entram em papel personalizado.
UPDATE wacrm.permission_catalog
   SET grantable = NOT owner_only AND key NOT IN ('integrations.manage')
 WHERE grantable IS DISTINCT FROM (NOT owner_only AND key NOT IN ('integrations.manage'));

-- 2. Implicações de escopo (espelho de IMPLIES em permissions.ts e de compat_role_for da 241).
CREATE OR REPLACE FUNCTION wacrm.expand_permissions(p_perms text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(DISTINCT x.p ORDER BY x.p), '{}'::text[])
    FROM (
      SELECT unnest(coalesce(p_perms, '{}'::text[])) AS p
      UNION ALL SELECT 'conversations.scope_team' WHERE 'conversations.scope_all'    = ANY (coalesce(p_perms, '{}'::text[]))
      UNION ALL SELECT 'monitoring.view_team'     WHERE 'monitoring.view_all'        = ANY (coalesce(p_perms, '{}'::text[]))
      UNION ALL SELECT 'reports.view_team'        WHERE 'reports.view_all'           = ANY (coalesce(p_perms, '{}'::text[]))
      UNION ALL SELECT 'intelligence.use'         WHERE 'intelligence.scope_account' = ANY (coalesce(p_perms, '{}'::text[]))
    ) x
   WHERE x.p IS NOT NULL
$$;

-- 3. Validação do conjunto (mesmos códigos e mesma ordem de checagem de validateCustomRolePermissions).
CREATE OR REPLACE FUNCTION wacrm.custom_role_permission_errors(p_perms text[])
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH given AS (
    SELECT DISTINCT g AS key FROM unnest(coalesce(p_perms, '{}'::text[])) AS g WHERE g IS NOT NULL
  ),
  present AS (
    SELECT unnest(wacrm.expand_permissions(ARRAY(SELECT key FROM given))) AS key
  ),
  errs AS (
    SELECT g.key AS sort_key, 0 AS ord,
           CASE
             WHEN c.key IS NULL THEN jsonb_build_object('code', 'unknown_permission', 'permission', g.key)
             WHEN c.owner_only THEN jsonb_build_object('code', 'owner_only', 'permission', g.key)
             ELSE jsonb_build_object('code', 'not_grantable', 'permission', g.key)
           END AS err
      FROM given g
      LEFT JOIN wacrm.permission_catalog c ON c.key = g.key
     WHERE c.key IS NULL OR c.owner_only OR NOT c.grantable
    UNION ALL
    SELECT g.key, 1, jsonb_build_object('code', 'missing_dependency', 'permission', g.key, 'requires', d.dep)
      FROM given g
      JOIN wacrm.permission_catalog c ON c.key = g.key AND NOT c.owner_only AND c.grantable
     CROSS JOIN LATERAL unnest(c.depends_on) AS d(dep)
     WHERE NOT EXISTS (SELECT 1 FROM present p WHERE p.key = d.dep)
  )
  SELECT coalesce(jsonb_agg(err ORDER BY sort_key, ord, err ->> 'requires'), '[]'::jsonb) FROM errs
$$;

REVOKE ALL ON FUNCTION wacrm.expand_permissions(text[]), wacrm.custom_role_permission_errors(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.expand_permissions(text[]), wacrm.custom_role_permission_errors(text[]) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('312_custom_role_validation') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
