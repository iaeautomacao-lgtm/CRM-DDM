-- ============================================================
-- 319_invitation_role_id.sql   (TASK5 — cargo escolhido no convite; pedido do dono de 13/10)
--
-- O QUE FAZ:
--   1. account_invitations.role_id: o cargo escolhido ao convidar (de sistema ou personalizado da MESMA organização).
--      A coluna `role` (enum) continua obrigatória e recebe o compat do cargo: convite antigo (sem role_id) funciona igual.
--      Se o personalizado for apagado antes do aceite, role_id vira NULL e vale o `role` (compat).
--   2. Ao aceitar (accepted_at preenchido pela redeem_invitation, 048 — não reescrita), um trigger aplica o role_id ao
--      perfil de quem aceitou; a sincronia (profiles_sync_role, 318) acerta o account_role. Cargo de outra organização ou
--      "proprietário" nunca é aplicado (fica o `role`).
--   3. Trigger de consistência no INSERT/UPDATE do convite: role_id de outra organização ou "proprietário" é recusado.
--   Quem pode oferecer qual cargo (só abaixo de quem convida, sem escalada) é checado pela rota com
--   wacrm.role_assignable (318) antes de gravar.
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.account_invitations'), to_regprocedure('wacrm.role_assignable(uuid,uuid,uuid)');   -- não nulos (017/318)
--   SELECT column_name FROM information_schema.columns
--    WHERE table_schema = 'wacrm' AND table_name = 'account_invitations' AND column_name = 'role_id';             -- 0 linhas na 1ª vez
-- VERIFICAÇÃO:
--   SELECT tgname FROM pg_trigger WHERE tgname IN ('trg_invitation_role_check', 'trg_invitation_apply_role');      -- 2 linhas
--   SELECT version FROM wacrm.schema_migrations WHERE version = '319_invitation_role_id';
-- ORDEM: depois da 318 e ANTES do deploy (a rota de convite grava role_id). Idempotente.
-- ROLLBACK:
--   BEGIN;
--   DROP TRIGGER IF EXISTS trg_invitation_apply_role ON wacrm.account_invitations;
--   DROP TRIGGER IF EXISTS trg_invitation_role_check ON wacrm.account_invitations;
--   DROP FUNCTION IF EXISTS wacrm.invitation_apply_role(), wacrm.invitation_role_check();
--   ALTER TABLE wacrm.account_invitations DROP COLUMN IF EXISTS role_id;
--   DELETE FROM wacrm.schema_migrations WHERE version = '319_invitation_role_id';
--   COMMIT;   (antes: reverter o deploy da rota de convite)
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.account_invitations') IS NULL OR to_regclass('wacrm.account_roles') IS NULL THEN
    RAISE EXCEPTION '319: faltam wacrm.account_invitations (017) / account_roles (240)';
  END IF;
  IF to_regprocedure('wacrm.role_assignable(uuid,uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION '319: aplique a 318 antes';
  END IF;
END $$;

ALTER TABLE wacrm.account_invitations
  ADD COLUMN IF NOT EXISTS role_id uuid REFERENCES wacrm.account_roles(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION wacrm.invitation_role_check()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_account uuid;
  v_key text;
  v_found boolean;
BEGIN
  IF NEW.role_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT r.account_id, r.key, true INTO v_account, v_key, v_found FROM wacrm.account_roles r WHERE r.id = NEW.role_id;
  IF v_found IS NULL OR (v_account IS NOT NULL AND v_account <> NEW.account_id) THEN
    RAISE EXCEPTION 'Cargo do convite não pertence a esta organização' USING ERRCODE = '42501';
  END IF;
  IF v_account IS NULL AND v_key = 'owner' THEN
    RAISE EXCEPTION 'Convite não pode dar o cargo de proprietário' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.invitation_role_check() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_invitation_role_check ON wacrm.account_invitations;
CREATE TRIGGER trg_invitation_role_check
  BEFORE INSERT OR UPDATE OF role_id, account_id ON wacrm.account_invitations
  FOR EACH ROW EXECUTE FUNCTION wacrm.invitation_role_check();

CREATE OR REPLACE FUNCTION wacrm.invitation_apply_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.accepted_at IS NULL OR OLD.accepted_at IS NOT NULL OR NEW.role_id IS NULL OR NEW.accepted_by_user_id IS NULL THEN
    RETURN NULL;
  END IF;
  -- Só cargo de sistema (não proprietário) ou personalizado desta organização; a sincronia acerta o account_role.
  UPDATE wacrm.profiles p SET role_id = NEW.role_id
   WHERE p.user_id = NEW.accepted_by_user_id
     AND p.account_id = NEW.account_id
     AND p.account_role::text <> 'owner'
     AND EXISTS (
       SELECT 1 FROM wacrm.account_roles r
        WHERE r.id = NEW.role_id
          AND ((r.account_id IS NULL AND r.key <> 'owner') OR r.account_id = NEW.account_id)
     );
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.invitation_apply_role() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS trg_invitation_apply_role ON wacrm.account_invitations;
CREATE TRIGGER trg_invitation_apply_role
  AFTER UPDATE OF accepted_at ON wacrm.account_invitations
  FOR EACH ROW EXECUTE FUNCTION wacrm.invitation_apply_role();

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('319_invitation_role_id') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
