-- ============================================================
-- 241_roles_functions.sql   (PRD 20, fase 20.2 — funções de verificação, SEM mudança de comportamento)
--
-- Só CRIA funções. Nenhuma policy, RPC ou rota as usa ainda (a migração por domínio vem nas fases seguintes):
--   wacrm.has_perm(p_perm text) → boolean      o usuário logado (auth.uid()) tem a permissão? Fail-closed: sem perfil,
--                                              sem role_id ou chave desconhecida = false. STABLE + SECURITY DEFINER,
--                                              search_path vazio. 1 organização por usuário ⇒ não recebe account_id.
--                                              (O PRD cita `p.status = 'active'`: a coluna chega com a 242 — a função
--                                              será recriada lá.)
--   wacrm.my_permissions() → text[]            as permissões efetivas do usuário logado (ordenadas).
--   wacrm.role_rank(p_role_id uuid) → integer  rank do papel (sistema 5..1); NULL se não existir.
--   wacrm.compat_role_for(p_perms text[]) → text   o menor papel de SISTEMA (viewer<agent<supervisor<admin) cujo
--                                              conjunto contém todas as permissões (com as implicações de escopo:
--                                              *_all ⇒ *_team); nenhum contém ⇒ 'admin' (teto de um personalizado).
--                                              Espelha compatRoleFor() de src/lib/auth/permissions.ts.
-- `current_account_id()` NÃO foi alterada (o PRD prevê revisão; sem necessidade nesta fase).
--
-- PRÉ-REQUISITO: a 240 aplicada (tabelas e profiles.role_id). O pré-check abaixo aborta sem alterar nada se faltar.
-- ORDEM: antes ou depois do deploy (nada no app chama estas funções ainda). Idempotente (CREATE OR REPLACE).
--
-- PRÉ-CHECK:
--   SELECT to_regclass('wacrm.account_roles'), to_regclass('wacrm.role_permissions');       -- não nulos (240)
--   SELECT count(*) FROM information_schema.columns
--     WHERE table_schema='wacrm' AND table_name='profiles' AND column_name='role_id';       -- 1
--   SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--     WHERE p.proname IN ('has_perm','my_permissions','role_rank','compat_role_for');        -- vazio na 1ª vez; cópia em
--     -- `public` = drift (PRD 20, P-19): reconciliar antes
--
-- VERIFICAÇÃO (como usuário logado — no SQL Editor o auth.uid() é nulo e dá false/vazio):
--   SELECT wacrm.has_perm('inbox.view'), wacrm.my_permissions();
--   SELECT wacrm.compat_role_for(ARRAY['inbox.view','inbox.reply']);                        -- agent
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS wacrm.has_perm(text);
--   DROP FUNCTION IF EXISTS wacrm.my_permissions();
--   DROP FUNCTION IF EXISTS wacrm.role_rank(uuid);
--   DROP FUNCTION IF EXISTS wacrm.compat_role_for(text[]);
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.account_roles') IS NULL OR to_regclass('wacrm.role_permissions') IS NULL THEN
    RAISE EXCEPTION '241: falta a migration 240 (account_roles/role_permissions)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'wacrm' AND table_name = 'profiles' AND column_name = 'role_id'
  ) THEN
    RAISE EXCEPTION '241: falta wacrm.profiles.role_id (migration 240)';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION wacrm.has_perm(p_perm text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM wacrm.profiles p
      JOIN wacrm.role_permissions rp ON rp.role_id = p.role_id
     WHERE p.user_id = auth.uid()
       AND rp.permission = p_perm
  )
$$;

CREATE OR REPLACE FUNCTION wacrm.my_permissions()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(rp.permission ORDER BY rp.permission), '{}'::text[])
    FROM wacrm.profiles p
    JOIN wacrm.role_permissions rp ON rp.role_id = p.role_id
   WHERE p.user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION wacrm.role_rank(p_role_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT r.rank FROM wacrm.account_roles r WHERE r.id = p_role_id
$$;

CREATE OR REPLACE FUNCTION wacrm.compat_role_for(p_perms text[])
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH wanted AS (
    SELECT DISTINCT w
      FROM (
        SELECT unnest(coalesce(p_perms, '{}'::text[])) AS w
        -- implicações de escopo (espelho de IMPLIES em permissions.ts): a mais ampla implica a mais estreita
        UNION ALL SELECT 'conversations.scope_team' WHERE 'conversations.scope_all' = ANY (coalesce(p_perms, '{}'::text[]))
        UNION ALL SELECT 'monitoring.view_team'     WHERE 'monitoring.view_all'     = ANY (coalesce(p_perms, '{}'::text[]))
        UNION ALL SELECT 'reports.view_team'        WHERE 'reports.view_all'        = ANY (coalesce(p_perms, '{}'::text[]))
        UNION ALL SELECT 'intelligence.use'         WHERE 'intelligence.scope_account' = ANY (coalesce(p_perms, '{}'::text[]))
      ) x
  )
  SELECT coalesce(
    (SELECT r.key
       FROM wacrm.account_roles r
      WHERE r.account_id IS NULL
        AND r.key <> 'owner'
        AND NOT EXISTS (
          SELECT 1 FROM wanted
           WHERE NOT EXISTS (
             SELECT 1 FROM wacrm.role_permissions rp WHERE rp.role_id = r.id AND rp.permission = wanted.w
           )
        )
      ORDER BY r.rank
      LIMIT 1),
    'admin'
  )
$$;

REVOKE ALL ON FUNCTION wacrm.has_perm(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION wacrm.my_permissions() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION wacrm.role_rank(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION wacrm.compat_role_for(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.has_perm(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION wacrm.my_permissions() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION wacrm.role_rank(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION wacrm.compat_role_for(text[]) TO authenticated, service_role;

-- Registro (202): tolera banco sem a 202 ainda; idempotente.
DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('241_roles_functions') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
