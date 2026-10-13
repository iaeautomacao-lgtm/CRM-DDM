-- ============================================================
-- 318_roles_by_level.sql   (TASK5 — cargos e permissões por organização; pedido do dono de 13/10)
--
-- O QUE FAZ:
--   1. roles.manage deixa de ser ownerOnly: vale para ADMIN e acima (o papel admin de sistema recebe a chave). Continua
--      NÃO concedível (grantable = false): não entra em personalizado nem em ajuste de cargo.
--   2. wacrm.account_role_overrides: ajuste das permissões de um cargo de SISTEMA (menos o proprietário) POR ORGANIZAÇÃO.
--      O padrão global (role_permissions dos papéis de sistema) NÃO muda. Linha = conjunto efetivo (já expandido) + o
--      compat_role recalculado. Sem linha = padrão. "Restaurar padrão" apaga a linha.
--   3. has_perm / my_permissions passam a ler o ajuste da organização (as policies que usam has_perm acompanham).
--      wacrm.member_permissions(user) dá o conjunto efetivo de qualquer membro (uso do servidor).
--   4. Nível (regra "só abaixo de você"): wacrm.role_level(role) = rank do cargo de sistema (5..1); personalizado =
--      least(rank do compat, 3) + 0,5 (sempre abaixo do admin). Um cargo está abaixo do ator se o nível dele < o do ator.
--   5. Regras (no banco, além do servidor):
--        gerir cargos = ter roles.manage (admin e acima);
--        só cargos ABAIXO do seu nível, nunca o seu próprio cargo, nunca o proprietário;
--        SEM ESCALADA: ninguém concede permissão que não tem (o proprietário tem todas);
--        ownerOnly e não concedíveis nunca entram (custom_role_permission_errors, 312); dependências validadas.
--      Erros 42501 trazem DETAIL jsonb: {"code":"role_level"} ou {"code":"escalation","permissions":[...]}.
--   6. RPCs novas (SECURITY DEFINER, search_path vazio, só service_role):
--        set_system_role_permissions(conta, ator, cargo, permissões) e reset_system_role_permissions(conta, ator, cargo)
--        role_assignable(conta, ator, cargo) → compat do cargo, ou erro (usada no convite, 319, e na atribuição).
--      E as da 313 (create/update/delete_custom_role, assign_member_role) são recriadas com as regras acima (antes: só o
--      proprietário). A sincronia profiles_sync_role passa a considerar o compat do ajuste da organização.
--   7. Auditoria: trigger em account_role_overrides (role.system_customized / role.system_reset, antes → depois, ator dos
--      cabeçalhos x-audit-*). Os personalizados seguem auditados pela 248.
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regprocedure('wacrm.create_custom_role(uuid,uuid,text,text,text[])'),
--          to_regprocedure('wacrm.custom_role_permission_errors(text[])'),
--          to_regprocedure('wacrm.compat_role_for(text[])'),
--          to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)');   -- todos não nulos (313/312/241/131)
--   SELECT owner_only, grantable FROM wacrm.permission_catalog WHERE key = 'roles.manage';            -- true, false (antes)
--   SELECT to_regclass('wacrm.account_role_overrides');                                               -- NULL na 1ª vez
-- VERIFICAÇÃO:
--   SELECT owner_only, grantable FROM wacrm.permission_catalog WHERE key = 'roles.manage';            -- false, false
--   SELECT 1 FROM wacrm.role_permissions rp JOIN wacrm.account_roles r ON r.id = rp.role_id
--    WHERE r.account_id IS NULL AND r.key = 'admin' AND rp.permission = 'roles.manage';               -- 1 linha
--   SELECT version FROM wacrm.schema_migrations WHERE version = '318_roles_by_level';
-- ORDEM: ANTES do deploy (as rotas de cargos e o getCurrentAccount passam a ler o ajuste). Depois, a 319. Idempotente.
-- ROLLBACK (só sem ajustes de cargo em uso; reaplique as funções da 241 e da 313 para voltar às versões anteriores):
--   BEGIN;
--   DELETE FROM wacrm.account_role_overrides;   -- (devolve o account_role dos membros antes: reset_system_role_permissions por cargo)
--   DROP TABLE IF EXISTS wacrm.account_role_overrides;
--   DROP FUNCTION IF EXISTS wacrm.set_system_role_permissions(uuid, uuid, uuid, text[]), wacrm.reset_system_role_permissions(uuid, uuid, uuid),
--     wacrm.role_assignable(uuid, uuid, uuid), wacrm.role_manager(uuid, uuid), wacrm.role_level(uuid),
--     wacrm.member_permissions(uuid), wacrm.role_permissions_in(uuid, uuid), wacrm.audit_role_overrides(),
--     wacrm.role_assert_no_escalation(text[], text[], boolean, numeric), wacrm.role_assert_manageable(uuid, numeric, uuid, uuid);
--   DELETE FROM wacrm.role_permissions rp USING wacrm.account_roles r
--    WHERE rp.role_id = r.id AND r.account_id IS NULL AND r.key = 'admin' AND rp.permission = 'roles.manage';
--   UPDATE wacrm.permission_catalog SET owner_only = true, label = 'Gerir papéis personalizados',
--     description = 'Criar, editar, apagar e atribuir papéis personalizados.' WHERE key = 'roles.manage';
--   -- e reaplique has_perm/my_permissions (241) e as RPCs + profiles_sync_role (313)
--   DELETE FROM wacrm.schema_migrations WHERE version = '318_roles_by_level';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('wacrm.create_custom_role(uuid,uuid,text,text,text[])') IS NULL
     OR to_regprocedure('wacrm.custom_role_permission_errors(text[])') IS NULL
     OR to_regprocedure('wacrm.expand_permissions(text[])') IS NULL THEN
    RAISE EXCEPTION '318: faltam as migrations 312/313 (papel personalizado)';
  END IF;
  IF to_regprocedure('wacrm.compat_role_for(text[])') IS NULL OR to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '318: faltam as funções da 241 (compat_role_for/has_perm)';
  END IF;
  IF to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION '318: falta wacrm.audit_write (migration 131)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM wacrm.permission_catalog WHERE key = 'roles.manage') THEN
    RAISE EXCEPTION '318: catálogo sem roles.manage — confira o seed da 240';
  END IF;
END $$;

-- 1. roles.manage para admin e acima (continua não concedível).
UPDATE wacrm.permission_catalog
   SET owner_only = false, grantable = false, label = 'Gerir cargos',
       description = 'Criar e editar cargos personalizados, ajustar as permissões dos cargos abaixo do seu e atribuí-los.'
 WHERE key = 'roles.manage';
INSERT INTO wacrm.role_permissions (role_id, permission)
SELECT r.id, 'roles.manage' FROM wacrm.account_roles r WHERE r.account_id IS NULL AND r.key = 'admin'
ON CONFLICT (role_id, permission) DO NOTHING;

-- 2. Ajuste por organização.
CREATE TABLE IF NOT EXISTS wacrm.account_role_overrides (
  account_id  uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  role_id     uuid NOT NULL REFERENCES wacrm.account_roles(id) ON DELETE CASCADE,
  permissions text[] NOT NULL,
  compat_role text NOT NULL CHECK (compat_role IN ('admin', 'supervisor', 'agent', 'viewer')),
  updated_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, role_id)
);
ALTER TABLE wacrm.account_role_overrides ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.account_role_overrides FROM PUBLIC, anon, authenticated;
GRANT SELECT ON wacrm.account_role_overrides TO authenticated;
GRANT ALL ON wacrm.account_role_overrides TO service_role;
DROP POLICY IF EXISTS account_role_overrides_select ON wacrm.account_role_overrides;
CREATE POLICY account_role_overrides_select ON wacrm.account_role_overrides FOR SELECT TO authenticated
  USING (account_id = (SELECT wacrm.current_account_id()));
DO $$ BEGIN
  IF to_regprocedure('wacrm.apply_mfa_policy(regclass)') IS NOT NULL THEN
    PERFORM wacrm.apply_mfa_policy('wacrm.account_role_overrides'::regclass);   -- regra 8 do _MODELO (310)
  END IF;
END $$;

-- 3. Permissões efetivas.
-- Conjunto do cargo NA organização: ajuste (se houver) ou o do cargo.
CREATE OR REPLACE FUNCTION wacrm.role_permissions_in(p_role uuid, p_account uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(
    (SELECT o.permissions FROM wacrm.account_role_overrides o WHERE o.role_id = p_role AND o.account_id = p_account),
    (SELECT coalesce(array_agg(rp.permission ORDER BY rp.permission), '{}'::text[])
       FROM wacrm.role_permissions rp WHERE rp.role_id = p_role)
  )
$$;

CREATE OR REPLACE FUNCTION wacrm.member_permissions(p_user uuid)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((SELECT wacrm.role_permissions_in(p.role_id, p.account_id) FROM wacrm.profiles p WHERE p.user_id = p_user), '{}'::text[])
$$;

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
      LEFT JOIN wacrm.account_role_overrides o ON o.account_id = p.account_id AND o.role_id = p.role_id
     WHERE p.user_id = auth.uid()
       AND CASE
             WHEN o.role_id IS NOT NULL THEN p_perm = ANY (o.permissions)
             ELSE EXISTS (SELECT 1 FROM wacrm.role_permissions rp WHERE rp.role_id = p.role_id AND rp.permission = p_perm)
           END
  )
$$;

CREATE OR REPLACE FUNCTION wacrm.my_permissions()
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT ARRAY(SELECT unnest(wacrm.member_permissions(auth.uid())) ORDER BY 1)
$$;

-- 4. Nível.
CREATE OR REPLACE FUNCTION wacrm.role_level(p_role uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT CASE WHEN r.kind = 'system' THEN r.rank::numeric ELSE least(r.rank, 3)::numeric + 0.5 END
    FROM wacrm.account_roles r WHERE r.id = p_role
$$;

-- 5. Regras.
-- Ator que gere cargos: membro da conta com roles.manage. Devolve nível, cargo e permissões efetivas.
CREATE OR REPLACE FUNCTION wacrm.role_manager(p_account uuid, p_actor uuid,
  OUT level numeric, OUT role_id uuid, OUT perms text[], OUT is_owner boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_account IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'Argumentos inválidos' USING ERRCODE = '22023';
  END IF;
  SELECT wacrm.role_level(p.role_id), p.role_id, wacrm.role_permissions_in(p.role_id, p.account_id), p.account_role::text = 'owner'
    INTO level, role_id, perms, is_owner
    FROM wacrm.profiles p
   WHERE p.user_id = p_actor AND p.account_id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Você não pertence a esta organização' USING ERRCODE = '42501';
  END IF;
  IF NOT is_owner AND NOT ('roles.manage' = ANY (perms)) THEN
    RAISE EXCEPTION 'Você não pode gerir cargos' USING ERRCODE = '42501', DETAIL = '{"code":"forbidden"}';
  END IF;
END;
$$;

-- Sem escalada: tudo que se concede precisa estar no conjunto do ator OU no padrão de um cargo de sistema abaixo dele
-- (ex.: inbox.receive_assignments é só do Operador; o admin não a tem, mas gere o Operador). O proprietário concede tudo.
CREATE OR REPLACE FUNCTION wacrm.role_assert_no_escalation(p_actor_perms text[], p_perms text[], p_is_owner boolean, p_actor_level numeric)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_missing text[];
BEGIN
  IF p_is_owner THEN RETURN; END IF;
  SELECT coalesce(array_agg(x ORDER BY x), '{}'::text[]) INTO v_missing
    FROM unnest(wacrm.expand_permissions(p_perms)) AS x
   WHERE NOT (x = ANY (coalesce(p_actor_perms, '{}'::text[])))
     AND NOT EXISTS (
       SELECT 1 FROM wacrm.role_permissions rp JOIN wacrm.account_roles r ON r.id = rp.role_id
        WHERE r.account_id IS NULL AND r.rank < p_actor_level AND rp.permission = x
     );
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION 'Você não pode conceder permissões que não tem' USING ERRCODE = '42501',
      DETAIL = jsonb_build_object('code', 'escalation', 'permissions', to_jsonb(v_missing))::text;
  END IF;
END;
$$;

-- Cargo que o ator pode atribuir/convidar: abaixo do nível dele, da organização (personalizado) e sem escalada. Devolve
-- o compat EFETIVO do cargo na organização. Serve a quem tem members.invite (não exige roles.manage).
CREATE OR REPLACE FUNCTION wacrm.role_assignable(p_account uuid, p_actor uuid, p_role uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_level numeric;
  v_actor_perms text[];
  v_is_owner boolean;
  v_role wacrm.account_roles;
  v_compat text;
BEGIN
  SELECT wacrm.role_level(p.role_id), wacrm.role_permissions_in(p.role_id, p.account_id), p.account_role::text = 'owner'
    INTO v_actor_level, v_actor_perms, v_is_owner
    FROM wacrm.profiles p WHERE p.user_id = p_actor AND p.account_id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Você não pertence a esta organização' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_role FROM wacrm.account_roles r WHERE r.id = p_role;
  IF NOT FOUND OR (v_role.account_id IS NOT NULL AND v_role.account_id <> p_account) THEN
    RAISE EXCEPTION 'Cargo não encontrado nesta organização' USING ERRCODE = 'P0002';
  END IF;
  IF v_role.account_id IS NULL AND v_role.key = 'owner' THEN
    RAISE EXCEPTION 'Use a transferência de propriedade para tornar alguém proprietário' USING ERRCODE = '22023';
  END IF;
  IF wacrm.role_level(p_role) >= v_actor_level THEN
    RAISE EXCEPTION 'Esse cargo é do seu nível ou acima' USING ERRCODE = '42501', DETAIL = '{"code":"role_level"}';
  END IF;
  PERFORM wacrm.role_assert_no_escalation(v_actor_perms, wacrm.role_permissions_in(p_role, p_account), v_is_owner, v_actor_level);
  SELECT coalesce(o.compat_role, v_role.compat_role) INTO v_compat
    FROM (SELECT 1) x LEFT JOIN wacrm.account_role_overrides o ON o.role_id = p_role AND o.account_id = p_account;
  RETURN v_compat;
END;
$$;

-- Ator pode gerir este cargo (editar/apagar/ajustar)? Abaixo do nível dele, nunca o próprio, nunca o proprietário.
CREATE OR REPLACE FUNCTION wacrm.role_assert_manageable(p_account uuid, p_actor_level numeric, p_actor_role uuid, p_role uuid)
RETURNS wacrm.account_roles
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role wacrm.account_roles;
BEGIN
  SELECT * INTO v_role FROM wacrm.account_roles r WHERE r.id = p_role;
  IF NOT FOUND OR (v_role.account_id IS NOT NULL AND v_role.account_id <> p_account) THEN
    RAISE EXCEPTION 'Cargo não encontrado nesta organização' USING ERRCODE = 'P0002';
  END IF;
  IF p_role = p_actor_role OR (v_role.account_id IS NULL AND v_role.key = 'owner') OR wacrm.role_level(p_role) >= p_actor_level THEN
    RAISE EXCEPTION 'Você só gere cargos abaixo do seu' USING ERRCODE = '42501', DETAIL = '{"code":"role_level"}';
  END IF;
  RETURN v_role;
END;
$$;

-- 6a. Ajuste de cargo de sistema por organização.
CREATE OR REPLACE FUNCTION wacrm.set_system_role_permissions(p_account uuid, p_actor uuid, p_role uuid, p_permissions text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  m record;
  v_role wacrm.account_roles;
  v_errors jsonb;
  v_keep text[];
  v_effective text[];
  v_old_compat text;
  v_compat text;
  v_members integer := 0;
BEGIN
  SELECT * INTO m FROM wacrm.role_manager(p_account, p_actor);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wacrm.custom_roles:' || p_account::text, 0));
  v_role := wacrm.role_assert_manageable(p_account, m.level, m.role_id, p_role);
  IF v_role.kind <> 'system' THEN
    RAISE EXCEPTION 'Use a edição de cargo personalizado' USING ERRCODE = '22023';
  END IF;
  IF p_permissions IS NULL THEN
    RAISE EXCEPTION 'Informe as permissões' USING ERRCODE = '22023';
  END IF;
  v_errors := wacrm.custom_role_permission_errors(p_permissions);
  IF jsonb_array_length(v_errors) > 0 THEN
    RAISE EXCEPTION 'Permissões inválidas para este cargo' USING ERRCODE = '22023', DETAIL = v_errors::text;
  END IF;
  PERFORM wacrm.role_assert_no_escalation(m.perms, p_permissions, m.is_owner, m.level);

  -- O que não é concedível no padrão do cargo (ex.: roles.manage do admin) fica como está.
  SELECT coalesce(array_agg(rp.permission), '{}'::text[]) INTO v_keep
    FROM wacrm.role_permissions rp JOIN wacrm.permission_catalog c ON c.key = rp.permission
   WHERE rp.role_id = p_role AND NOT c.grantable;
  v_effective := wacrm.expand_permissions(p_permissions || v_keep);
  v_compat := wacrm.compat_role_for(v_effective);
  IF v_compat = 'owner' THEN v_compat := 'admin'; END IF;

  SELECT coalesce(o.compat_role, v_role.compat_role) INTO v_old_compat
    FROM (SELECT 1) x LEFT JOIN wacrm.account_role_overrides o ON o.role_id = p_role AND o.account_id = p_account;

  INSERT INTO wacrm.account_role_overrides (account_id, role_id, permissions, compat_role, updated_by, updated_at)
  VALUES (p_account, p_role, v_effective, v_compat, p_actor, now())
  ON CONFLICT (account_id, role_id) DO UPDATE
    SET permissions = EXCLUDED.permissions, compat_role = EXCLUDED.compat_role,
        updated_by = EXCLUDED.updated_by, updated_at = now();

  UPDATE wacrm.profiles p SET account_role = v_compat::wacrm.account_role_enum
   WHERE p.role_id = p_role AND p.account_id = p_account AND p.account_role::text <> v_compat;
  GET DIAGNOSTICS v_members = ROW_COUNT;

  RETURN jsonb_build_object('id', p_role, 'compat_role', v_compat, 'previous_compat_role', v_old_compat,
    'members_updated', v_members, 'customized', true);
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.reset_system_role_permissions(p_account uuid, p_actor uuid, p_role uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  m record;
  v_role wacrm.account_roles;
  v_members integer := 0;
BEGIN
  SELECT * INTO m FROM wacrm.role_manager(p_account, p_actor);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wacrm.custom_roles:' || p_account::text, 0));
  v_role := wacrm.role_assert_manageable(p_account, m.level, m.role_id, p_role);
  IF v_role.kind <> 'system' THEN
    RAISE EXCEPTION 'Só cargo de sistema tem padrão para restaurar' USING ERRCODE = '22023';
  END IF;
  DELETE FROM wacrm.account_role_overrides o WHERE o.account_id = p_account AND o.role_id = p_role;
  UPDATE wacrm.profiles p SET account_role = v_role.compat_role::wacrm.account_role_enum
   WHERE p.role_id = p_role AND p.account_id = p_account AND p.account_role::text <> v_role.compat_role;
  GET DIAGNOSTICS v_members = ROW_COUNT;
  RETURN jsonb_build_object('id', p_role, 'compat_role', v_role.compat_role, 'members_updated', v_members, 'customized', false);
END;
$$;

-- 6b. Personalizados (313) com as regras novas: admin e acima, só abaixo do seu nível, sem escalada.
CREATE OR REPLACE FUNCTION wacrm.create_custom_role(p_account uuid, p_actor uuid, p_name text, p_description text, p_permissions text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  m record;
  v_name text;
  v_perms text[];
  v_errors jsonb;
  v_compat text;
  v_rank integer;
  v_id uuid;
  v_key text;
BEGIN
  SELECT * INTO m FROM wacrm.role_manager(p_account, p_actor);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wacrm.custom_roles:' || p_account::text, 0));

  IF (SELECT count(*) FROM wacrm.account_roles r WHERE r.account_id = p_account) >= 20 THEN
    RAISE EXCEPTION 'Limite de 20 papéis personalizados por organização atingido' USING ERRCODE = '54000';
  END IF;
  v_name := wacrm.custom_role_check_name(p_account, NULL, p_name);
  IF char_length(coalesce(p_description, '')) > 300 THEN
    RAISE EXCEPTION 'A descrição deve ter até 300 caracteres' USING ERRCODE = '22023';
  END IF;
  IF coalesce(array_length(p_permissions, 1), 0) = 0 THEN
    RAISE EXCEPTION 'Escolha ao menos uma permissão' USING ERRCODE = '22023';
  END IF;
  v_errors := wacrm.custom_role_permission_errors(p_permissions);
  IF jsonb_array_length(v_errors) > 0 THEN
    RAISE EXCEPTION 'Permissões inválidas para um papel personalizado' USING ERRCODE = '22023', DETAIL = v_errors::text;
  END IF;
  PERFORM wacrm.role_assert_no_escalation(m.perms, p_permissions, m.is_owner, m.level);
  v_perms := wacrm.expand_permissions(p_permissions);
  v_compat := wacrm.compat_role_for(v_perms);
  SELECT r.rank INTO v_rank FROM wacrm.account_roles r WHERE r.account_id IS NULL AND r.key = v_compat;
  -- Nível do novo cargo (personalizado: até 3,5) precisa ficar abaixo do ator.
  IF least(v_rank, 3)::numeric + 0.5 >= m.level THEN
    RAISE EXCEPTION 'Esse cargo ficaria no seu nível ou acima' USING ERRCODE = '42501', DETAIL = '{"code":"role_level"}';
  END IF;
  v_key := 'custom_' || left(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 12);

  INSERT INTO wacrm.account_roles (account_id, key, name, description, kind, rank, compat_role, created_by, updated_by)
  VALUES (p_account, v_key, v_name, nullif(btrim(coalesce(p_description, '')), ''), 'custom', v_rank, v_compat, p_actor, p_actor)
  RETURNING id INTO v_id;
  INSERT INTO wacrm.role_permissions (role_id, permission) SELECT v_id, p FROM unnest(v_perms) AS p;

  RETURN jsonb_build_object('id', v_id, 'key', v_key, 'compat_role', v_compat);
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.update_custom_role(
  p_account uuid, p_actor uuid, p_role uuid, p_name text, p_description text, p_permissions text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  m record;
  v_role wacrm.account_roles;
  v_old_compat text;
  v_name text;
  v_perms text[];
  v_errors jsonb;
  v_compat text;
  v_rank integer;
  v_members integer := 0;
BEGIN
  SELECT * INTO m FROM wacrm.role_manager(p_account, p_actor);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wacrm.custom_roles:' || p_account::text, 0));
  v_role := wacrm.role_assert_manageable(p_account, m.level, m.role_id, p_role);
  IF v_role.kind <> 'custom' THEN
    RAISE EXCEPTION 'Papel não encontrado nesta organização' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM wacrm.account_roles r WHERE r.id = p_role FOR UPDATE;
  v_old_compat := v_role.compat_role;
  v_compat := v_old_compat;

  IF p_name IS NOT NULL THEN
    v_name := wacrm.custom_role_check_name(p_account, p_role, p_name);
    UPDATE wacrm.account_roles SET name = v_name WHERE id = p_role AND name IS DISTINCT FROM v_name;
  END IF;
  IF p_description IS NOT NULL THEN
    IF char_length(p_description) > 300 THEN
      RAISE EXCEPTION 'A descrição deve ter até 300 caracteres' USING ERRCODE = '22023';
    END IF;
    UPDATE wacrm.account_roles SET description = nullif(btrim(p_description), '')
     WHERE id = p_role AND description IS DISTINCT FROM nullif(btrim(p_description), '');
  END IF;

  IF p_permissions IS NOT NULL THEN
    IF coalesce(array_length(p_permissions, 1), 0) = 0 THEN
      RAISE EXCEPTION 'Escolha ao menos uma permissão' USING ERRCODE = '22023';
    END IF;
    v_errors := wacrm.custom_role_permission_errors(p_permissions);
    IF jsonb_array_length(v_errors) > 0 THEN
      RAISE EXCEPTION 'Permissões inválidas para um papel personalizado' USING ERRCODE = '22023', DETAIL = v_errors::text;
    END IF;
    PERFORM wacrm.role_assert_no_escalation(m.perms, p_permissions, m.is_owner, m.level);
    v_perms := wacrm.expand_permissions(p_permissions);

    DELETE FROM wacrm.role_permissions rp WHERE rp.role_id = p_role AND NOT (rp.permission = ANY (v_perms));
    INSERT INTO wacrm.role_permissions (role_id, permission)
    SELECT p_role, p FROM unnest(v_perms) AS p
    ON CONFLICT (role_id, permission) DO NOTHING;

    v_compat := wacrm.compat_role_for(v_perms);
    IF v_compat IS DISTINCT FROM v_old_compat THEN
      SELECT r.rank INTO v_rank FROM wacrm.account_roles r WHERE r.account_id IS NULL AND r.key = v_compat;
      UPDATE wacrm.account_roles SET compat_role = v_compat, rank = v_rank WHERE id = p_role;
      UPDATE wacrm.profiles p SET account_role = v_compat::wacrm.account_role_enum
       WHERE p.role_id = p_role AND p.account_id = p_account;
      GET DIAGNOSTICS v_members = ROW_COUNT;
    END IF;
  END IF;

  UPDATE wacrm.account_roles SET updated_by = p_actor, updated_at = now() WHERE id = p_role;
  RETURN jsonb_build_object('id', p_role, 'compat_role', v_compat, 'previous_compat_role', v_old_compat,
    'members_updated', v_members);
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.delete_custom_role(p_account uuid, p_actor uuid, p_role uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  m record;
  v_role wacrm.account_roles;
  v_in_use integer;
BEGIN
  SELECT * INTO m FROM wacrm.role_manager(p_account, p_actor);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wacrm.custom_roles:' || p_account::text, 0));
  v_role := wacrm.role_assert_manageable(p_account, m.level, m.role_id, p_role);
  IF v_role.kind <> 'custom' THEN
    RAISE EXCEPTION 'Papel não encontrado nesta organização' USING ERRCODE = 'P0002';
  END IF;
  SELECT count(*) INTO v_in_use FROM wacrm.profiles p WHERE p.role_id = p_role;
  IF v_in_use > 0 THEN
    RAISE EXCEPTION 'O papel está em uso por % membro(s); mude o papel deles antes de apagar', v_in_use
      USING ERRCODE = '55006', DETAIL = v_in_use::text;
  END IF;
  DELETE FROM wacrm.account_roles WHERE id = p_role;
  RETURN jsonb_build_object('id', p_role, 'name', v_role.name);
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.assign_member_role(p_account uuid, p_actor uuid, p_target uuid, p_role uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  m record;
  v_prev_role uuid;
  v_prev_legacy text;
  v_compat text;
BEGIN
  SELECT * INTO m FROM wacrm.role_manager(p_account, p_actor);
  IF p_target IS NULL OR p_role IS NULL THEN
    RAISE EXCEPTION 'Argumentos inválidos' USING ERRCODE = '22023';
  END IF;
  IF p_target = p_actor THEN
    RAISE EXCEPTION 'Você não pode mudar o próprio papel' USING ERRCODE = '42501', DETAIL = '{"code":"role_level"}';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wacrm.custom_roles:' || p_account::text, 0));

  SELECT p.role_id, p.account_role::text INTO v_prev_role, v_prev_legacy
    FROM wacrm.profiles p
   WHERE p.user_id = p_target AND p.account_id = p_account
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Membro não encontrado nesta organização' USING ERRCODE = 'P0002';
  END IF;
  IF v_prev_legacy = 'owner' THEN
    RAISE EXCEPTION 'O papel do proprietário não muda por aqui (use a transferência de propriedade)' USING ERRCODE = '42501';
  END IF;
  -- O membro precisa estar ABAIXO do ator (o admin não muda o cargo de outro admin).
  IF coalesce(wacrm.role_level(v_prev_role), 0) >= m.level THEN
    RAISE EXCEPTION 'Esse membro é do seu nível ou acima' USING ERRCODE = '42501', DETAIL = '{"code":"role_level"}';
  END IF;
  v_compat := wacrm.role_assignable(p_account, p_actor, p_role);

  UPDATE wacrm.profiles p SET role_id = p_role
   WHERE p.user_id = p_target AND p.account_id = p_account AND p.role_id IS DISTINCT FROM p_role;

  RETURN jsonb_build_object('previous_role_id', v_prev_role, 'role_id', p_role, 'compat_role', v_compat);
END;
$$;

-- Sincronia account_role ⇄ role_id (313) considerando o compat do ajuste da organização.
CREATE OR REPLACE FUNCTION wacrm.profiles_sync_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, pg_catalog
AS $$
DECLARE
  v_role_changed boolean;
  v_legacy_changed boolean;
  v_account_changed boolean;
  v_compat text;
  v_role_account uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_role_changed := NEW.role_id IS NOT NULL;
    v_legacy_changed := NEW.account_role IS NOT NULL;
    v_account_changed := false;
  ELSE
    v_role_changed := NEW.role_id IS DISTINCT FROM OLD.role_id;
    v_legacy_changed := NEW.account_role IS DISTINCT FROM OLD.account_role;
    v_account_changed := NEW.account_id IS DISTINCT FROM OLD.account_id;
  END IF;

  IF NOT v_role_changed AND NOT v_legacy_changed AND NOT v_account_changed THEN
    RETURN NEW;
  END IF;

  IF NEW.role_id IS NOT NULL AND v_role_changed THEN
    SELECT coalesce(o.compat_role, r.compat_role), r.account_id INTO v_compat, v_role_account
      FROM wacrm.account_roles r
      LEFT JOIN wacrm.account_role_overrides o ON o.role_id = r.id AND o.account_id = NEW.account_id
     WHERE r.id = NEW.role_id;
    IF v_compat IS NULL THEN
      RAISE EXCEPTION 'role_id % não existe em account_roles', NEW.role_id USING ERRCODE = '23503';
    END IF;
    IF v_role_account IS NOT NULL AND v_role_account IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'O papel % pertence a outra organização', NEW.role_id USING ERRCODE = '42501';
    END IF;
    IF NEW.account_role IS NULL OR NEW.account_role::text <> v_compat THEN
      NEW.account_role := v_compat;
    END IF;
  ELSIF NEW.account_role IS NOT NULL THEN
    SELECT coalesce(o.compat_role, r.compat_role), r.account_id INTO v_compat, v_role_account
      FROM wacrm.account_roles r
      LEFT JOIN wacrm.account_role_overrides o ON o.role_id = r.id AND o.account_id = NEW.account_id
     WHERE r.id = NEW.role_id;
    IF NEW.role_id IS NULL OR v_compat IS NULL OR v_compat <> NEW.account_role::text
       OR (v_role_account IS NOT NULL AND v_role_account IS DISTINCT FROM NEW.account_id) THEN
      -- Escrita legada de account_role = "este cargo de sistema"; o account_role vira o compat efetivo dele na organização.
      SELECT r.id, coalesce(o.compat_role, r.compat_role) INTO NEW.role_id, v_compat
        FROM wacrm.account_roles r
        LEFT JOIN wacrm.account_role_overrides o ON o.role_id = r.id AND o.account_id = NEW.account_id
       WHERE r.account_id IS NULL AND r.key = NEW.account_role::text;
      IF v_compat IS NOT NULL AND v_compat <> NEW.account_role::text THEN
        NEW.account_role := v_compat;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.profiles_sync_role() FROM PUBLIC, anon, authenticated;

-- 7. Auditoria do ajuste de cargo de sistema.
CREATE OR REPLACE FUNCTION wacrm.audit_role_overrides()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_row wacrm.account_role_overrides := coalesce(NEW, OLD);
  v_name text;
  v_before text[];
  v_after text[];
BEGIN
  SELECT r.name INTO v_name FROM wacrm.account_roles r WHERE r.id = v_row.role_id;
  IF TG_OP = 'INSERT' THEN
    SELECT coalesce(array_agg(rp.permission ORDER BY rp.permission), '{}') INTO v_before FROM wacrm.role_permissions rp WHERE rp.role_id = NEW.role_id;
  ELSE
    v_before := OLD.permissions;
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT coalesce(array_agg(rp.permission ORDER BY rp.permission), '{}') INTO v_after FROM wacrm.role_permissions rp WHERE rp.role_id = OLD.role_id;
  ELSE
    v_after := NEW.permissions;
  END IF;
  PERFORM wacrm.audit_write(v_row.account_id, 'updated', 'role', v_row.role_id, v_name,
    CASE WHEN TG_OP = 'DELETE' THEN 'role.system_reset' ELSE 'role.system_customized' END,
    CASE WHEN TG_OP = 'DELETE' THEN format('Cargo %s voltou ao padrão', v_name) ELSE format('Permissões do cargo %s ajustadas', v_name) END,
    jsonb_build_object('permissions', jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_after))),
    jsonb_build_object(
      'added', to_jsonb(ARRAY(SELECT x FROM unnest(v_after) x EXCEPT SELECT y FROM unnest(v_before) y ORDER BY 1)),
      'removed', to_jsonb(ARRAY(SELECT y FROM unnest(v_before) y EXCEPT SELECT x FROM unnest(v_after) x ORDER BY 1)),
      'compat_role', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.compat_role END));
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_role_overrides falhou: %', SQLERRM;   -- auditoria nunca derruba a escrita
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.audit_role_overrides() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_audit_role_overrides ON wacrm.account_role_overrides;
CREATE TRIGGER trg_audit_role_overrides
  AFTER INSERT OR UPDATE OR DELETE ON wacrm.account_role_overrides
  FOR EACH ROW EXECUTE FUNCTION wacrm.audit_role_overrides();

-- Grants.
REVOKE ALL ON FUNCTION wacrm.role_permissions_in(uuid, uuid), wacrm.member_permissions(uuid), wacrm.role_level(uuid),
  wacrm.role_manager(uuid, uuid), wacrm.role_assert_no_escalation(text[], text[], boolean, numeric), wacrm.role_assignable(uuid, uuid, uuid),
  wacrm.role_assert_manageable(uuid, numeric, uuid, uuid), wacrm.set_system_role_permissions(uuid, uuid, uuid, text[]),
  wacrm.reset_system_role_permissions(uuid, uuid, uuid), wacrm.create_custom_role(uuid, uuid, text, text, text[]),
  wacrm.update_custom_role(uuid, uuid, uuid, text, text, text[]), wacrm.delete_custom_role(uuid, uuid, uuid),
  wacrm.assign_member_role(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.role_permissions_in(uuid, uuid), wacrm.member_permissions(uuid), wacrm.role_level(uuid),
  wacrm.role_assignable(uuid, uuid, uuid), wacrm.set_system_role_permissions(uuid, uuid, uuid, text[]),
  wacrm.reset_system_role_permissions(uuid, uuid, uuid), wacrm.create_custom_role(uuid, uuid, text, text, text[]),
  wacrm.update_custom_role(uuid, uuid, uuid, text, text, text[]), wacrm.delete_custom_role(uuid, uuid, uuid),
  wacrm.assign_member_role(uuid, uuid, uuid, uuid)
  TO service_role;
-- has_perm / my_permissions continuam como na 241 (authenticated + service_role).
REVOKE ALL ON FUNCTION wacrm.has_perm(text), wacrm.my_permissions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.has_perm(text), wacrm.my_permissions() TO authenticated, service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('318_roles_by_level') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
