-- ============================================================
-- 231_account_settings.sql   (PRD 19, 19.3 + PRD 24, item 6 — configurações da conta no banco, por conta)
--
-- Chave/valor TIPADO por registro em código (src/lib/settings/account-config.ts): fuso, horário de atendimento e preferências de
-- notificação da conta (e, nas próximas fases do PRD 19, modelo/teto do Intelligence e link do extrator). A tabela não conhece os tipos: a
-- ROTA valida cada chave contra o registro antes de gravar. Nada é semeado: sem linha = vale o padrão do registro.
--   wacrm.account_settings (account_id, key, value jsonb, updated_by, updated_at) — PRIMARY KEY (account_id, key)
--   Fechada: RLS ligada, sem policy; só service_role (rotas /api/settings/account-config*, que checam a permissão da sessão).
--   Auditoria: trigger próprio (audit_account_settings → audit_write da 131): quem, quando, antes → depois, e a observação (reason) que a
--   rota registra no contexto de auditoria. Os valores NÃO são sensíveis (fuso, horários, flags); credenciais ficam no cofre, nunca aqui.
--
-- PRÉ-CHECK:  SELECT to_regclass('wacrm.accounts');                                                              -- não nulo
--             SELECT to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)');       -- não nulo (131)
--             SELECT to_regclass('wacrm.account_settings');                                                       -- NULL na 1ª vez
-- ORDEM: antes ou depois do deploy (sem a 231 as rotas respondem 503). Idempotente. Tabela nova ⇒ sem `b`.
-- ROLLBACK:   BEGIN; DROP TABLE IF EXISTS wacrm.account_settings; DROP FUNCTION IF EXISTS wacrm.audit_account_settings();
--             DELETE FROM wacrm.schema_migrations WHERE version = '231_account_settings'; COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL THEN
    RAISE EXCEPTION '231: falta wacrm.accounts — confira o schema vivo';
  END IF;
  IF to_regprocedure('wacrm.audit_write(uuid,text,text,uuid,text,text,text,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION '231: falta a auditoria da migration 131 (audit_write)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.account_settings (
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  key        text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_.]{0,59}$'),
  value      jsonb NOT NULL,
  updated_by uuid,                                                   -- user_id de quem gravou (sem FK: o usuário pode sair da conta)
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, key),
  CONSTRAINT account_settings_value_size CHECK (pg_column_size(value) <= 16384)
);

ALTER TABLE wacrm.account_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.account_settings FROM PUBLIC, anon, authenticated;
GRANT ALL ON wacrm.account_settings TO service_role;

CREATE OR REPLACE FUNCTION wacrm.audit_account_settings()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = wacrm, public, extensions
AS $$
DECLARE
  v_account uuid := coalesce(NEW.account_id, OLD.account_id);
  v_key text := coalesce(NEW.key, OLD.key);
BEGIN
  -- sem id próprio: o recurso auditado é a CHAVE da conta (uuid determinístico)
  PERFORM wacrm.audit_write(
    v_account,
    CASE TG_OP WHEN 'INSERT' THEN 'created' WHEN 'DELETE' THEN 'deleted' ELSE 'updated' END,
    'account_setting',
    md5(v_account::text || ':' || v_key)::uuid,
    v_key,
    CASE TG_OP WHEN 'DELETE' THEN 'account_setting.reset' ELSE 'account_setting.changed' END,
    CASE TG_OP WHEN 'DELETE' THEN format('Configuração %s voltou ao padrão', v_key) ELSE format('Configuração %s alterada', v_key) END,
    jsonb_build_object('value', jsonb_build_object('before', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD.value) END,
                                                   'after',  CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW.value) END)));
  RETURN NULL;
EXCEPTION WHEN others THEN
  RAISE WARNING 'audit_account_settings falhou: %', SQLERRM;  -- nunca derruba a escrita original
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.audit_account_settings() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_audit_account_settings ON wacrm.account_settings;
CREATE TRIGGER trg_audit_account_settings AFTER INSERT OR UPDATE OR DELETE ON wacrm.account_settings
  FOR EACH ROW EXECUTE FUNCTION wacrm.audit_account_settings();

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('231_account_settings') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
