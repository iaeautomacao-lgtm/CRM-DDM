-- ============================================================
-- 313_custom_roles.sql   (PRD 20 — papel personalizado, parte 2: criar, editar, apagar e atribuir)
--
-- Decisões do dono (09/10): só o PROPRIETÁRIO cria, edita, apaga e atribui (roles.manage); até 20 papéis por organização;
-- apagar papel em uso é recusado (com a contagem); nenhuma permissão ownerOnly/future entra (312); o RLS das leituras
-- diretas segue o compat_role nesta entrega (a troca para has_perm fica para a fase seguinte).
--
-- O QUE FAZ:
--   1. Nome único por organização (sem diferenciar maiúsculas), índice parcial nos personalizados.
--   2. wacrm.profiles_sync_role (240) recriada com DUAS correções para o personalizado:
--        a) escrita só de account_role que BATE com o compat_role do papel atual mantém o papel (é o que a edição de
--           permissões faz ao recalcular o compat dos membros; antes o trigger trocava o membro para o papel de sistema);
--        b) papel personalizado de OUTRA organização nunca fica no perfil: se o account_id mudar (membro removido ou
--           movido), o role_id volta ao papel de sistema do account_role.
--      Fora isso, idêntica à 240.
--   3. RPCs (SECURITY DEFINER, search_path vazio, só service_role; a rota exige roles.manage e o banco confere de novo que
--      o ator é o proprietário da organização):
--        create_custom_role(conta, ator, nome, descrição, permissões)      → {id, key, compat_role}
--        update_custom_role(conta, ator, papel, nome, descrição, permissões) (NULL = manter) → {id, compat_role,
--                           previous_compat_role, members_updated}; recalcula o compat e o account_role dos membros
--        delete_custom_role(conta, ator, papel)                            → {id, name}; recusa papel em uso
--        assign_member_role(conta, ator, membro, papel)                    → {previous_role_id, role_id, compat_role}
--                           papel de sistema (menos proprietário) ou personalizado da MESMA organização; nunca o
--                           proprietário nem a si mesmo
--      Permissões gravadas EXPANDIDAS (como as dos papéis de sistema), para has_perm() valer igual ao TS.
--      A auditoria vem das triggers da 248 (role.created/updated/deleted, role.permissions_changed, member.role_changed),
--      com o ator dos cabeçalhos x-audit-* do servidor.
--   ERROS (SQLSTATE → HTTP na rota): 42501 sem permissão/proprietário/si mesmo → 403 · P0002 não encontrado → 404 ·
--      22023 dados inválidos (DETAIL = lista jsonb de erros de permissão, quando houver) → 400 · 23505 nome repetido → 409 ·
--      54000 limite de 20 papéis → 409 · 55006 papel em uso (DETAIL = nº de membros) → 409.
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regprocedure('wacrm.custom_role_permission_errors(text[])'), to_regprocedure('wacrm.expand_permissions(text[])');  -- não nulos (312)
--   SELECT to_regprocedure('wacrm.compat_role_for(text[])'), to_regprocedure('wacrm.profiles_sync_role()');                       -- não nulos (241/240)
--   SELECT count(*) FROM wacrm.account_roles WHERE account_id IS NOT NULL;      -- 0 (nenhum personalizado ainda)
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'wacrm.profiles'::regclass AND tgname = 'profiles_sync_role';   -- 1 linha
-- VERIFICAÇÃO:
--   SELECT indexname FROM pg_indexes WHERE schemaname = 'wacrm' AND indexname = 'uq_account_roles_custom_name';
--   SELECT version FROM wacrm.schema_migrations WHERE version = '313_custom_roles';
-- ORDEM: 312 e 313 ANTES do deploy (as rotas /api/account/roles chamam estas RPCs; sem elas respondem 503). Idempotente.
-- ROLLBACK (só sem papéis personalizados em uso; com eles, reatribua os membros antes):
--   BEGIN;
--   DROP FUNCTION IF EXISTS wacrm.create_custom_role(uuid, uuid, text, text, text[]),
--     wacrm.update_custom_role(uuid, uuid, uuid, text, text, text[]), wacrm.delete_custom_role(uuid, uuid, uuid),
--     wacrm.assign_member_role(uuid, uuid, uuid, uuid), wacrm.custom_role_assert_owner(uuid, uuid),
--     wacrm.custom_role_check_name(uuid, uuid, text);
--   DROP INDEX IF EXISTS wacrm.uq_account_roles_custom_name;
--   -- profiles_sync_role() de volta ao corpo da 240 (literal; copie sem o prefixo "--   "):
--   CREATE OR REPLACE FUNCTION wacrm.profiles_sync_role()
--   RETURNS trigger
--   LANGUAGE plpgsql
--   SECURITY DEFINER
--   SET search_path = wacrm, pg_catalog
--   AS $$
--   DECLARE
--     v_role_changed boolean;
--     v_legacy_changed boolean;
--     v_compat text;
--     v_role_account uuid;
--   BEGIN
--     IF TG_OP = 'INSERT' THEN
--       v_role_changed := NEW.role_id IS NOT NULL;
--       v_legacy_changed := NEW.account_role IS NOT NULL;
--     ELSE
--       v_role_changed := NEW.role_id IS DISTINCT FROM OLD.role_id;
--       v_legacy_changed := NEW.account_role IS DISTINCT FROM OLD.account_role;
--     END IF;
--
--     IF NOT v_role_changed AND NOT v_legacy_changed THEN
--       RETURN NEW;
--     END IF;
--
--     IF NEW.role_id IS NOT NULL AND v_role_changed THEN
--       SELECT r.compat_role, r.account_id INTO v_compat, v_role_account
--         FROM wacrm.account_roles r WHERE r.id = NEW.role_id;
--       IF v_compat IS NULL THEN
--         RAISE EXCEPTION 'role_id % não existe em account_roles', NEW.role_id USING ERRCODE = '23503';
--       END IF;
--       IF v_role_account IS NOT NULL AND v_role_account IS DISTINCT FROM NEW.account_id THEN
--         RAISE EXCEPTION 'O papel % pertence a outra organização', NEW.role_id USING ERRCODE = '42501';
--       END IF;
--       IF NEW.account_role IS NULL OR NEW.account_role::text <> v_compat THEN
--         NEW.account_role := v_compat;   -- text → enum (conversão de E/S na atribuição do plpgsql)
--       END IF;
--     ELSIF NEW.account_role IS NOT NULL THEN
--       SELECT r.id INTO NEW.role_id
--         FROM wacrm.account_roles r
--        WHERE r.account_id IS NULL AND r.key = NEW.account_role::text;
--     END IF;
--
--     RETURN NEW;
--   END;
--   $$;
--   REVOKE ALL ON FUNCTION wacrm.profiles_sync_role() FROM PUBLIC, anon, authenticated;
--   DELETE FROM wacrm.schema_migrations WHERE version = '313_custom_roles';
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('wacrm.custom_role_permission_errors(text[])') IS NULL OR to_regprocedure('wacrm.expand_permissions(text[])') IS NULL THEN
    RAISE EXCEPTION '313: falta a migration 312 (custom_role_permission_errors/expand_permissions)';
  END IF;
  IF to_regprocedure('wacrm.compat_role_for(text[])') IS NULL OR to_regprocedure('wacrm.profiles_sync_role()') IS NULL THEN
    RAISE EXCEPTION '313: faltam as migrations 240/241 (compat_role_for/profiles_sync_role)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema = 'wacrm' AND table_name = 'profiles' AND column_name = 'role_id'
  ) THEN
    RAISE EXCEPTION '313: falta wacrm.profiles.role_id (migration 240)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM wacrm.account_roles WHERE account_id IS NOT NULL
     GROUP BY account_id, lower(btrim(name)) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '313: há papéis personalizados com nome repetido na mesma organização — resolva antes do índice único';
  END IF;
END $$;

-- 1. Nome único por organização (tabela pequena: índice comum, sem CONCURRENTLY).
CREATE UNIQUE INDEX IF NOT EXISTS uq_account_roles_custom_name
  ON wacrm.account_roles (account_id, lower(btrim(name))) WHERE account_id IS NOT NULL;

-- 2. Sincronia account_role ⇄ role_id (240) com as correções do personalizado.
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
    SELECT r.compat_role, r.account_id INTO v_compat, v_role_account
      FROM wacrm.account_roles r WHERE r.id = NEW.role_id;
    IF v_compat IS NULL THEN
      RAISE EXCEPTION 'role_id % não existe em account_roles', NEW.role_id USING ERRCODE = '23503';
    END IF;
    IF v_role_account IS NOT NULL AND v_role_account IS DISTINCT FROM NEW.account_id THEN
      RAISE EXCEPTION 'O papel % pertence a outra organização', NEW.role_id USING ERRCODE = '42501';
    END IF;
    IF NEW.account_role IS NULL OR NEW.account_role::text <> v_compat THEN
      NEW.account_role := v_compat;   -- text → enum (conversão de E/S na atribuição do plpgsql)
    END IF;
  ELSIF NEW.account_role IS NOT NULL THEN
    -- Papel atual continua valendo se for da mesma organização (ou de sistema) e o account_role bater com o compat dele.
    SELECT r.compat_role, r.account_id INTO v_compat, v_role_account
      FROM wacrm.account_roles r WHERE r.id = NEW.role_id;
    IF NEW.role_id IS NULL OR v_compat IS NULL OR v_compat <> NEW.account_role::text
       OR (v_role_account IS NOT NULL AND v_role_account IS DISTINCT FROM NEW.account_id) THEN
      SELECT r.id INTO NEW.role_id
        FROM wacrm.account_roles r
       WHERE r.account_id IS NULL AND r.key = NEW.account_role::text;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.profiles_sync_role() FROM PUBLIC, anon, authenticated;

-- 3. RPCs ------------------------------------------------------------------------------------------------------------

-- Ator precisa ser o proprietário da organização (defesa em profundidade: a rota já exige roles.manage).
CREATE OR REPLACE FUNCTION wacrm.custom_role_assert_owner(p_account uuid, p_actor uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_account IS NULL OR p_actor IS NULL THEN
    RAISE EXCEPTION 'Argumentos inválidos' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM wacrm.profiles p
     WHERE p.user_id = p_actor AND p.account_id = p_account AND p.account_role::text = 'owner'
  ) THEN
    RAISE EXCEPTION 'Só o proprietário gerencia papéis personalizados' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Nome: 1–80 caracteres, sem repetir outro papel da organização nem o nome de um papel de sistema. Devolve o nome limpo.
CREATE OR REPLACE FUNCTION wacrm.custom_role_check_name(p_account uuid, p_role uuid, p_name text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
BEGIN
  IF v_name = '' OR char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'O nome do papel deve ter de 1 a 80 caracteres' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM wacrm.account_roles r
     WHERE r.account_id IS NULL AND (lower(r.name) = lower(v_name) OR lower(r.key) = lower(v_name))
  ) THEN
    RAISE EXCEPTION 'Esse nome é de um papel padrão; escolha outro' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (
    SELECT 1 FROM wacrm.account_roles r
     WHERE r.account_id = p_account AND lower(btrim(r.name)) = lower(v_name) AND r.id IS DISTINCT FROM p_role
  ) THEN
    RAISE EXCEPTION 'Já existe um papel com esse nome nesta organização' USING ERRCODE = '23505';
  END IF;
  RETURN v_name;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.create_custom_role(p_account uuid, p_actor uuid, p_name text, p_description text, p_permissions text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_name text;
  v_perms text[];
  v_errors jsonb;
  v_compat text;
  v_rank integer;
  v_id uuid;
  v_key text;
BEGIN
  PERFORM wacrm.custom_role_assert_owner(p_account, p_actor);
  -- Serializa as escritas de papéis da organização (limite e nome único sem corrida).
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
  v_perms := wacrm.expand_permissions(p_permissions);
  v_compat := wacrm.compat_role_for(v_perms);
  SELECT r.rank INTO v_rank FROM wacrm.account_roles r WHERE r.account_id IS NULL AND r.key = v_compat;
  v_key := 'custom_' || left(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 12);

  INSERT INTO wacrm.account_roles (account_id, key, name, description, kind, rank, compat_role, created_by, updated_by)
  VALUES (p_account, v_key, v_name, nullif(btrim(coalesce(p_description, '')), ''), 'custom', v_rank, v_compat, p_actor, p_actor)
  RETURNING id INTO v_id;

  INSERT INTO wacrm.role_permissions (role_id, permission)
  SELECT v_id, p FROM unnest(v_perms) AS p;

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
  v_old_compat text;
  v_name text;
  v_perms text[];
  v_errors jsonb;
  v_compat text;
  v_rank integer;
  v_members integer := 0;
BEGIN
  PERFORM wacrm.custom_role_assert_owner(p_account, p_actor);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wacrm.custom_roles:' || p_account::text, 0));

  SELECT r.compat_role INTO v_old_compat
    FROM wacrm.account_roles r
   WHERE r.id = p_role AND r.account_id = p_account AND r.kind = 'custom'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Papel não encontrado nesta organização' USING ERRCODE = 'P0002';
  END IF;
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
    v_perms := wacrm.expand_permissions(p_permissions);

    -- Diferença (não apaga e regrava tudo): a auditoria da 248 registra só o que mudou.
    DELETE FROM wacrm.role_permissions rp WHERE rp.role_id = p_role AND NOT (rp.permission = ANY (v_perms));
    INSERT INTO wacrm.role_permissions (role_id, permission)
    SELECT p_role, p FROM unnest(v_perms) AS p
    ON CONFLICT (role_id, permission) DO NOTHING;

    v_compat := wacrm.compat_role_for(v_perms);
    IF v_compat IS DISTINCT FROM v_old_compat THEN
      SELECT r.rank INTO v_rank FROM wacrm.account_roles r WHERE r.account_id IS NULL AND r.key = v_compat;
      UPDATE wacrm.account_roles SET compat_role = v_compat, rank = v_rank WHERE id = p_role;
      -- O trigger de sincronia (acima) mantém o role_id porque o account_role novo bate com o compat do papel.
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
  v_name text;
  v_in_use integer;
BEGIN
  PERFORM wacrm.custom_role_assert_owner(p_account, p_actor);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wacrm.custom_roles:' || p_account::text, 0));

  SELECT r.name INTO v_name
    FROM wacrm.account_roles r
   WHERE r.id = p_role AND r.account_id = p_account AND r.kind = 'custom'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Papel não encontrado nesta organização' USING ERRCODE = 'P0002';
  END IF;

  SELECT count(*) INTO v_in_use FROM wacrm.profiles p WHERE p.role_id = p_role;
  IF v_in_use > 0 THEN
    RAISE EXCEPTION 'O papel está em uso por % membro(s); mude o papel deles antes de apagar', v_in_use
      USING ERRCODE = '55006', DETAIL = v_in_use::text;
  END IF;

  DELETE FROM wacrm.account_roles WHERE id = p_role;   -- role_permissions caem em cascata
  RETURN jsonb_build_object('id', p_role, 'name', v_name);
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.assign_member_role(p_account uuid, p_actor uuid, p_target uuid, p_role uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prev_role uuid;
  v_prev_legacy text;
  v_role_account uuid;
  v_role_key text;
  v_compat text;
BEGIN
  PERFORM wacrm.custom_role_assert_owner(p_account, p_actor);
  IF p_target IS NULL OR p_role IS NULL THEN
    RAISE EXCEPTION 'Argumentos inválidos' USING ERRCODE = '22023';
  END IF;
  IF p_target = p_actor THEN
    RAISE EXCEPTION 'Você não pode mudar o próprio papel' USING ERRCODE = '42501';
  END IF;
  -- Mesmo lock das escritas de papéis: não atribui um papel que está sendo apagado.
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

  SELECT r.account_id, r.key, r.compat_role INTO v_role_account, v_role_key, v_compat
    FROM wacrm.account_roles r WHERE r.id = p_role;
  IF NOT FOUND OR (v_role_account IS NOT NULL AND v_role_account <> p_account) THEN
    RAISE EXCEPTION 'Papel não encontrado nesta organização' USING ERRCODE = 'P0002';
  END IF;
  IF v_role_account IS NULL AND v_role_key = 'owner' THEN
    RAISE EXCEPTION 'Use a transferência de propriedade para tornar alguém proprietário' USING ERRCODE = '22023';
  END IF;

  UPDATE wacrm.profiles p SET role_id = p_role
   WHERE p.user_id = p_target AND p.account_id = p_account AND p.role_id IS DISTINCT FROM p_role;

  RETURN jsonb_build_object('previous_role_id', v_prev_role, 'role_id', p_role, 'compat_role', v_compat);
END;
$$;

REVOKE ALL ON FUNCTION wacrm.custom_role_assert_owner(uuid, uuid), wacrm.custom_role_check_name(uuid, uuid, text),
  wacrm.create_custom_role(uuid, uuid, text, text, text[]), wacrm.update_custom_role(uuid, uuid, uuid, text, text, text[]),
  wacrm.delete_custom_role(uuid, uuid, uuid), wacrm.assign_member_role(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.create_custom_role(uuid, uuid, text, text, text[]),
  wacrm.update_custom_role(uuid, uuid, uuid, text, text, text[]), wacrm.delete_custom_role(uuid, uuid, uuid),
  wacrm.assign_member_role(uuid, uuid, uuid, uuid) TO service_role;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('313_custom_roles') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
