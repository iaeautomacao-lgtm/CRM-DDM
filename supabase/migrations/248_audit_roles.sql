-- ============================================================
-- 248_audit_roles.sql   (PRD 20, 20.8 — auditoria de papéis, convites, vínculo e propriedade; PRD seção 6.8)
--
-- Usa a auditoria que já existe (wacrm.audit_logs + audit_write/audit_actor, migration 131): NENHUMA coluna ou tipo novo.
-- Só triggers novas (AFTER, à prova de falha: auditoria nunca derruba a escrita original). Ator, IP e origem vêm de
-- audit_actor() como nas demais. Nenhum dado sensível entra no log (token_hash de convite NUNCA é lido).
--
-- EVENTOS (action → resource_type; conta = a da ORGANIZAÇÃO AFETADA):
--   member.role_changed          profiles.account_role / role_id mudou DENTRO da mesma conta (antes → depois)
--   member.removed / member.joined   profiles.account_id mudou: "saiu" é gravado na conta ANTIGA e "entrou" na NOVA
--                                (correção do P-09: antes o evento de vínculo caía só na conta nova, como "alterado")
--   member.deactivated / member.reactivated   profiles.status (coluna criada na 242; lida por to_jsonb, então esta
--                                migration funciona antes e depois da 242)
--   ownership.transferred        accounts.owner_user_id mudou (e account.renamed quando só o nome muda)
--   invitation.created / invitation.revoked / invitation.accepted   account_invitations (INSERT / DELETE de convite
--                                pendente / accepted_at preenchido), com papel e quem convidou/aceitou
--   role.created / role.updated / role.deleted   account_roles de papéis PERSONALIZADOS (ainda não existem; já ficam auditados)
--   role.permissions_changed     role_permissions de papéis personalizados, UM evento por papel e comando com o diff de chaves
-- O trigger genérico de profiles (131) deixa de registrar `account_role` (agora tem evento próprio, sem duplicar).
-- `access.denied` NÃO é do banco: o 403 de requirePermission é registrado pelo app (src/lib/audit/access-denied.ts), com limite.
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)'), to_regprocedure('wacrm.audit_agent_name(uuid)'),
--          to_regprocedure('wacrm.audit_generic_changes()');                      -- todos não nulos (131)
--   SELECT to_regclass('wacrm.account_roles'), to_regclass('wacrm.role_permissions'), to_regclass('wacrm.account_invitations');  -- não nulos (240/017)
--   SELECT tgname FROM pg_trigger WHERE tgrelid IN ('wacrm.profiles'::regclass,'wacrm.accounts'::regclass,'wacrm.account_invitations'::regclass) AND NOT tgisinternal;
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'audit_logs_event_type_check';   -- inclui 'action'
-- VERIFICAÇÃO (depois): SELECT tgname FROM pg_trigger WHERE tgname LIKE 'trg_audit_%' AND NOT tgisinternal ORDER BY 1;
--   -- mude o papel de um membro de teste e leia: SELECT action, summary, changes FROM wacrm.audit_logs ORDER BY created_at DESC LIMIT 5;
-- ORDEM: antes ou depois do deploy (o app não depende dela). Idempotente (DROP TRIGGER IF EXISTS + CREATE OR REPLACE).
-- ROLLBACK:
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_audit_profiles_membership ON wacrm.profiles;
--   DROP TRIGGER IF EXISTS trg_audit_accounts_owner ON wacrm.accounts;
--   DROP TRIGGER IF EXISTS trg_audit_account_invitations ON wacrm.account_invitations;
--   DROP TRIGGER IF EXISTS trg_audit_account_roles ON wacrm.account_roles;
--   DROP TRIGGER IF EXISTS trg_audit_role_permissions_added ON wacrm.role_permissions;
--   DROP TRIGGER IF EXISTS trg_audit_role_permissions_removed ON wacrm.role_permissions;
--   DROP FUNCTION IF EXISTS wacrm.audit_profile_membership(), wacrm.audit_account_owner(), wacrm.audit_account_invitations(),
--     wacrm.audit_account_roles(), wacrm.audit_role_permissions_added(), wacrm.audit_role_permissions_removed();
--   -- e devolva `account_role` ao trigger genérico de profiles (cols: full_name,account_role,max_simultaneous_chats):
--   DROP TRIGGER IF EXISTS trg_audit_profiles ON wacrm.profiles;
--   CREATE TRIGGER trg_audit_profiles AFTER INSERT OR UPDATE OR DELETE ON wacrm.profiles FOR EACH ROW
--     EXECUTE FUNCTION wacrm.audit_generic_changes('member', 'Membro', 'full_name', 'full_name,account_role,max_simultaneous_chats');
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)') IS NULL
     OR to_regprocedure('wacrm.audit_agent_name(uuid)') IS NULL
     OR to_regprocedure('wacrm.audit_generic_changes()') IS NULL THEN
    RAISE EXCEPTION '248: falta a auditoria da migration 131 (audit_write/audit_agent_name/audit_generic_changes)';
  END IF;
  IF to_regclass('wacrm.audit_logs') IS NULL OR to_regclass('wacrm.profiles') IS NULL OR to_regclass('wacrm.accounts') IS NULL
     OR to_regclass('wacrm.account_invitations') IS NULL THEN
    RAISE EXCEPTION '248: faltam wacrm.audit_logs/profiles/accounts/account_invitations';
  END IF;
  IF to_regclass('wacrm.account_roles') IS NULL OR to_regclass('wacrm.role_permissions') IS NULL THEN
    RAISE EXCEPTION '248: falta a migration 240 (account_roles/role_permissions)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_event_type_check'
       AND conrelid = 'wacrm.audit_logs'::regclass AND pg_get_constraintdef(oid) LIKE '%action%'
  ) THEN
    RAISE EXCEPTION '248: audit_logs.event_type não aceita ''action'' (migration 131) — confira o schema vivo';
  END IF;
END $$;

-- ---- profiles: papel, vínculo (saiu/entrou) e ativação ------------------------------------------------------------
CREATE OR REPLACE FUNCTION wacrm.audit_profile_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_name       text := coalesce(nullif(NEW.full_name, ''), 'Membro');
  v_old_role   text := OLD.account_role::text;
  v_new_role   text := NEW.account_role::text;
  v_old_rid    text := to_jsonb(OLD) ->> 'role_id';
  v_new_rid    text := to_jsonb(NEW) ->> 'role_id';
  v_old_status text := to_jsonb(OLD) ->> 'status';
  v_new_status text := to_jsonb(NEW) ->> 'status';
  v_changes    jsonb;
BEGIN
  IF OLD.account_id IS DISTINCT FROM NEW.account_id THEN
    -- Vínculo mudou (remover membro, aceitar convite): um evento em CADA conta (P-09).
    PERFORM wacrm.audit_write(OLD.account_id, 'deleted', 'member', NEW.id, v_name, 'member.removed',
      format('%s saiu da organização (papel %s)', v_name, v_old_role),
      jsonb_build_object('account_id', jsonb_build_object('before', OLD.account_id, 'after', NEW.account_id)),
      jsonb_build_object('role', v_old_role, 'user_id', NEW.user_id, 'to_account_id', NEW.account_id));
    PERFORM wacrm.audit_write(NEW.account_id, 'created', 'member', NEW.id, v_name, 'member.joined',
      format('%s entrou na organização como %s', v_name, v_new_role),
      jsonb_build_object('account_role', jsonb_build_object('before', v_old_role, 'after', v_new_role)),
      jsonb_build_object('role', v_new_role, 'user_id', NEW.user_id, 'from_account_id', OLD.account_id));
  ELSIF v_old_role IS DISTINCT FROM v_new_role OR v_old_rid IS DISTINCT FROM v_new_rid THEN
    v_changes := '{}'::jsonb;
    IF v_old_role IS DISTINCT FROM v_new_role THEN
      v_changes := v_changes || jsonb_build_object('account_role', jsonb_build_object('before', v_old_role, 'after', v_new_role));
    END IF;
    IF v_old_rid IS DISTINCT FROM v_new_rid THEN
      v_changes := v_changes || jsonb_build_object('role_id', jsonb_build_object('before', v_old_rid, 'after', v_new_rid));
    END IF;
    PERFORM wacrm.audit_write(NEW.account_id, 'updated', 'member', NEW.id, v_name, 'member.role_changed',
      format('Papel de %s alterado: %s → %s', v_name, v_old_role, v_new_role),
      v_changes, jsonb_build_object('user_id', NEW.user_id));
  END IF;

  -- Ativação (profiles.status só existe depois da 242; antes, ambos NULL e nada acontece).
  IF v_old_status IS DISTINCT FROM v_new_status THEN
    IF v_new_status = 'disabled' THEN
      PERFORM wacrm.audit_write(NEW.account_id, 'updated', 'member', NEW.id, v_name, 'member.deactivated',
        format('%s foi desativado(a)', v_name),
        jsonb_build_object('status', jsonb_build_object('before', v_old_status, 'after', v_new_status)),
        jsonb_build_object('user_id', NEW.user_id));
    ELSIF v_old_status = 'disabled' THEN
      PERFORM wacrm.audit_write(NEW.account_id, 'updated', 'member', NEW.id, v_name, 'member.reactivated',
        format('%s foi reativado(a)', v_name),
        jsonb_build_object('status', jsonb_build_object('before', v_old_status, 'after', v_new_status)),
        jsonb_build_object('user_id', NEW.user_id));
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_profile_membership falhou: %', SQLERRM;  -- auditoria nunca derruba a escrita original
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.audit_profile_membership() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_audit_profiles_membership ON wacrm.profiles;
CREATE TRIGGER trg_audit_profiles_membership
  AFTER UPDATE ON wacrm.profiles
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW)
  EXECUTE FUNCTION wacrm.audit_profile_membership();

-- O trigger genérico de profiles (131) deixa de registrar account_role: agora há evento próprio (sem duplicar).
DROP TRIGGER IF EXISTS trg_audit_profiles ON wacrm.profiles;
CREATE TRIGGER trg_audit_profiles
  AFTER INSERT OR UPDATE OR DELETE ON wacrm.profiles
  FOR EACH ROW EXECUTE FUNCTION wacrm.audit_generic_changes('member', 'Membro', 'full_name', 'full_name,max_simultaneous_chats');

-- ---- accounts: propriedade e nome ----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION wacrm.audit_account_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
BEGIN
  IF OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
    PERFORM wacrm.audit_write(NEW.id, 'updated', 'account', NEW.id, NEW.name, 'ownership.transferred',
      format('Propriedade da organização transferida de %s para %s',
        wacrm.audit_agent_name(OLD.owner_user_id), wacrm.audit_agent_name(NEW.owner_user_id)),
      jsonb_build_object('owner_user_id', jsonb_build_object('before', OLD.owner_user_id, 'after', NEW.owner_user_id)));
  END IF;
  IF OLD.name IS DISTINCT FROM NEW.name THEN
    PERFORM wacrm.audit_write(NEW.id, 'updated', 'account', NEW.id, NEW.name, 'account.renamed',
      format('Organização renomeada: %s → %s', OLD.name, NEW.name),
      jsonb_build_object('name', jsonb_build_object('before', OLD.name, 'after', NEW.name)));
  END IF;
  RETURN NEW;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_account_owner falhou: %', SQLERRM;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.audit_account_owner() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_audit_accounts_owner ON wacrm.accounts;
CREATE TRIGGER trg_audit_accounts_owner
  AFTER UPDATE ON wacrm.accounts
  FOR EACH ROW WHEN (OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id OR OLD.name IS DISTINCT FROM NEW.name)
  EXECUTE FUNCTION wacrm.audit_account_owner();

-- ---- convites -----------------------------------------------------------------------------------------------------
-- NUNCA lê token_hash. Papel por to_jsonb (a coluna pode virar role_id na fase de convite com papel).
CREATE OR REPLACE FUNCTION wacrm.audit_account_invitations()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_row   jsonb := to_jsonb(coalesce(NEW, OLD));
  v_role  text := coalesce(v_row ->> 'role', v_row ->> 'role_id');
  v_label text := coalesce(nullif(v_row ->> 'label', ''), 'Convite (' || coalesce(v_role, '?') || ')');
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM wacrm.audit_write(NEW.account_id, 'created', 'invitation', NEW.id, v_label, 'invitation.created',
      format('Convite criado para o papel %s por %s', v_role, wacrm.audit_agent_name(NEW.created_by_user_id)),
      NULL,
      jsonb_build_object('role', v_role, 'expires_at', NEW.expires_at, 'created_by_user_id', NEW.created_by_user_id));
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL THEN
      PERFORM wacrm.audit_write(NEW.account_id, 'updated', 'invitation', NEW.id, v_label, 'invitation.accepted',
        format('Convite aceito por %s (papel %s)', wacrm.audit_agent_name(NEW.accepted_by_user_id), v_role),
        NULL,
        jsonb_build_object('role', v_role, 'accepted_by_user_id', NEW.accepted_by_user_id,
                           'created_by_user_id', NEW.created_by_user_id));
    END IF;
  ELSE -- DELETE: revogar convite pendente (convite já aceito sumindo na limpeza não é revogação)
    IF OLD.accepted_at IS NULL THEN
      PERFORM wacrm.audit_write(OLD.account_id, 'deleted', 'invitation', OLD.id, v_label, 'invitation.revoked',
        format('Convite para o papel %s revogado', v_role),
        NULL,
        jsonb_build_object('role', v_role, 'created_by_user_id', OLD.created_by_user_id));
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_account_invitations falhou: %', SQLERRM;  -- ex.: exclusão em cascata da organização
  RETURN coalesce(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION wacrm.audit_account_invitations() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_audit_account_invitations ON wacrm.account_invitations;
CREATE TRIGGER trg_audit_account_invitations
  AFTER INSERT OR UPDATE OR DELETE ON wacrm.account_invitations
  FOR EACH ROW EXECUTE FUNCTION wacrm.audit_account_invitations();

-- ---- papéis personalizados (os de sistema são imutáveis e não geram evento) -----------------------------------------
CREATE OR REPLACE FUNCTION wacrm.audit_account_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_row     jsonb := to_jsonb(coalesce(NEW, OLD));
  v_changes jsonb := '{}'::jsonb;
  v_col     text;
BEGIN
  IF (v_row ->> 'kind') IS DISTINCT FROM 'custom' THEN
    RETURN coalesce(NEW, OLD);
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM wacrm.audit_write(NEW.account_id, 'created', 'role', NEW.id, NEW.name, 'role.created',
      format('Papel %s criado', NEW.name), NULL,
      jsonb_build_object('compat_role', NEW.compat_role, 'rank', NEW.rank));
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM wacrm.audit_write(OLD.account_id, 'deleted', 'role', OLD.id, OLD.name, 'role.deleted',
      format('Papel %s excluído', OLD.name), NULL, jsonb_build_object('compat_role', OLD.compat_role));
  ELSE
    FOREACH v_col IN ARRAY ARRAY['name', 'description', 'compat_role', 'rank'] LOOP
      IF to_jsonb(OLD) -> v_col IS DISTINCT FROM to_jsonb(NEW) -> v_col THEN
        v_changes := v_changes || jsonb_build_object(v_col, jsonb_build_object('before', to_jsonb(OLD) -> v_col, 'after', to_jsonb(NEW) -> v_col));
      END IF;
    END LOOP;
    IF v_changes <> '{}'::jsonb THEN
      PERFORM wacrm.audit_write(NEW.account_id, 'updated', 'role', NEW.id, NEW.name, 'role.updated',
        format('Papel %s alterado', NEW.name), v_changes);
    END IF;
  END IF;
  RETURN coalesce(NEW, OLD);
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_account_roles falhou: %', SQLERRM;
  RETURN coalesce(NEW, OLD);
END;
$$;
REVOKE ALL ON FUNCTION wacrm.audit_account_roles() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_audit_account_roles ON wacrm.account_roles;
CREATE TRIGGER trg_audit_account_roles
  AFTER INSERT OR UPDATE OR DELETE ON wacrm.account_roles
  FOR EACH ROW EXECUTE FUNCTION wacrm.audit_account_roles();

-- role_permissions: statement-level com tabela de transição → UM evento por papel e comando, com o diff de chaves.
CREATE OR REPLACE FUNCTION wacrm.audit_role_permissions_added()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT ro.id, ro.account_id, ro.name, array_agg(n.permission ORDER BY n.permission) AS keys
      FROM new_rows n JOIN wacrm.account_roles ro ON ro.id = n.role_id
     WHERE ro.kind = 'custom'
     GROUP BY ro.id, ro.account_id, ro.name
  LOOP
    PERFORM wacrm.audit_write(r.account_id, 'updated', 'role', r.id, r.name, 'role.permissions_changed',
      format('Papel %s: +%s permissão(ões)', r.name, cardinality(r.keys)), NULL,
      jsonb_build_object('added', to_jsonb(r.keys), 'removed', '[]'::jsonb));
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_role_permissions_added falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION wacrm.audit_role_permissions_removed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT ro.id, ro.account_id, ro.name, array_agg(o.permission ORDER BY o.permission) AS keys
      FROM old_rows o JOIN wacrm.account_roles ro ON ro.id = o.role_id
     WHERE ro.kind = 'custom'
     GROUP BY ro.id, ro.account_id, ro.name
  LOOP
    PERFORM wacrm.audit_write(r.account_id, 'updated', 'role', r.id, r.name, 'role.permissions_changed',
      format('Papel %s: −%s permissão(ões)', r.name, cardinality(r.keys)), NULL,
      jsonb_build_object('added', '[]'::jsonb, 'removed', to_jsonb(r.keys)));
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_role_permissions_removed falhou: %', SQLERRM;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.audit_role_permissions_added() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION wacrm.audit_role_permissions_removed() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_audit_role_permissions_added ON wacrm.role_permissions;
CREATE TRIGGER trg_audit_role_permissions_added
  AFTER INSERT ON wacrm.role_permissions
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION wacrm.audit_role_permissions_added();

DROP TRIGGER IF EXISTS trg_audit_role_permissions_removed ON wacrm.role_permissions;
CREATE TRIGGER trg_audit_role_permissions_removed
  AFTER DELETE ON wacrm.role_permissions
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION wacrm.audit_role_permissions_removed();

-- Registro (202): tolera banco sem a 202 ainda; idempotente.
DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('248_audit_roles') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
