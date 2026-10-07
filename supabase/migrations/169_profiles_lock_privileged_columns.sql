-- 169_profiles_lock_privileged_columns.sql
--
-- Correção C-1 (auditoria de segurança): a policy profiles_update (017)
-- só exige auth.uid() = user_id, sem restrição de coluna, e a 027 dá
-- GRANT ALL ON ALL TABLES ... TO anon, authenticated. Resultado: qualquer
-- usuário logado fazia, pelo PostgREST com a própria sessão,
--   update profiles set account_role = 'owner' (ou account_id = <outra conta>)
-- e virava owner / entrava em outra conta.
--
-- O navegador só escreve full_name e avatar_url
-- (src/components/settings/profile-form.tsx). Nenhuma rota de servidor
-- escreve em profiles com o cliente da sessão: bulk-invite usa service_role;
-- papel/equipe/limite de chats/convites/transferência passam pelas RPCs
-- SECURITY DEFINER (018, 019/048, 049, 116), que rodam como o dono da função
-- e continuam funcionando. O trigger de signup (handle_new_user) também é
-- SECURITY DEFINER.
--
-- Pré-checagem (rodar no SQL Editor ANTES e DEPOIS de aplicar):
--   SELECT column_name,
--     has_column_privilege('authenticated', 'wacrm.profiles', column_name, 'UPDATE') AS can_update,
--     has_column_privilege('authenticated', 'wacrm.profiles', column_name, 'INSERT') AS can_insert
--   FROM information_schema.columns
--   WHERE table_schema = 'wacrm' AND table_name = 'profiles'
--   ORDER BY ordinal_position;
-- Antes: tudo true (falha confirmada). Depois: can_update só em full_name e
-- avatar_url; can_insert tudo false.
--
-- Idempotente. Pode ser aplicada ANTES do deploy (o código atual do
-- navegador só escreve full_name/avatar_url).
BEGIN;

-- Um GRANT na tabela prevalece sobre permissões por coluna.
REVOKE INSERT, UPDATE ON wacrm.profiles FROM PUBLIC, anon, authenticated;

-- Limpar também eventuais grants por coluna, inclusive de execuções anteriores.
DO $$
DECLARE
  v_columns text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
    INTO v_columns
    FROM pg_attribute
   WHERE attrelid = 'wacrm.profiles'::regclass
     AND attnum > 0
     AND NOT attisdropped;

  EXECUTE format(
    'REVOKE INSERT (%s), UPDATE (%s) ON wacrm.profiles FROM PUBLIC, anon, authenticated',
    v_columns, v_columns
  );
END;
$$;

-- Única escrita legítima do navegador: nome e avatar do próprio perfil
-- (a policy profiles_update continua exigindo auth.uid() = user_id).
GRANT UPDATE (full_name, avatar_url) ON wacrm.profiles TO authenticated;

-- Servidor (service_role) mantém todas as permissões.
GRANT ALL ON wacrm.profiles TO service_role;

-- Defesa em profundidade: mesmo que algum GRANT futuro (ex.: um novo
-- "GRANT ALL ON ALL TABLES" como a 027) devolva as permissões, os papéis do
-- PostgREST (anon/authenticated) não conseguem criar perfis nem alterar
-- vínculo de conta/papel/usuário. Dentro das RPCs SECURITY DEFINER o
-- current_user é o dono da função (postgres), e no servidor é service_role,
-- então ambos passam.
CREATE OR REPLACE FUNCTION wacrm.profiles_guard_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = wacrm, public
AS $$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'Criação de perfil não permitida para este papel'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.account_role IS DISTINCT FROM OLD.account_role THEN
    RAISE EXCEPTION 'Alteração de conta/papel do perfil não permitida'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION wacrm.profiles_guard_privileged_columns() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS profiles_guard_privileged_columns ON wacrm.profiles;
CREATE TRIGGER profiles_guard_privileged_columns
  BEFORE INSERT OR UPDATE ON wacrm.profiles
  FOR EACH ROW EXECUTE FUNCTION wacrm.profiles_guard_privileged_columns();

COMMIT;
NOTIFY pgrst, 'reload schema';
