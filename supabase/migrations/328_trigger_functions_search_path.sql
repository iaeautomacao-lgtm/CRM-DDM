-- ============================================================
-- 328_trigger_functions_search_path.sql   (revisão de segurança 13/10, item 25 — RLS fase 3, item 3 do Sextante)
--
-- Funções de trigger criadas nas migrations 001, 028, 035, 036 e 038 sem `SET search_path` (quatro delas SECURITY DEFINER): quem controla o search_path da sessão
-- poderia sombrear tabelas/funções que elas usam sem qualificar (ex.: uuid_generate_v4). Fixa o search_path, sem mudar o corpo:
--   update_updated_at_column (001), wacrm.create_deal_for_new_contact (028), wacrm.sync_deal_title_on_contact_name_change (035),
--   wacrm.auto_manage_chat_tags (036), wacrm.seed_automation_templates (038).
-- search_path = wacrm, public, extensions, pg_temp  (pg_temp por último; `extensions` para uuid_generate_v4 no Supabase). As referências delas já são qualificadas (wacrm.*) ou
-- ficam no schema onde a função mora. Procura por NOME em pg_proc (schema/assinatura reais do banco vivo); o que não existir é ignorado. Idempotente.
--
-- PRÉ-CHECK:  SELECT n.nspname, p.proname, p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE p.proname IN ('update_updated_at_column','create_deal_for_new_contact','sync_deal_title_on_contact_name_change','auto_manage_chat_tags','seed_automation_templates');
-- VERIFICAÇÃO: o mesmo SELECT: proconfig = {search_path=wacrm, public, extensions, pg_temp}; atualizar um contato/conversa pelo app continua funcionando.
-- ORDEM: antes ou depois do deploy (só muda configuração da função). Rollback abaixo.
-- ROLLBACK:   DO $$ DECLARE f record; BEGIN FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p WHERE p.proname IN ('update_updated_at_column','create_deal_for_new_contact','sync_deal_title_on_contact_name_change','auto_manage_chat_tags','seed_automation_templates') AND p.pronamespace IN ('public'::regnamespace, 'wacrm'::regnamespace) LOOP EXECUTE format('ALTER FUNCTION %s RESET search_path', f.sig); END LOOP; END $$;
--             DELETE FROM wacrm.schema_migrations WHERE version = '328_trigger_functions_search_path';
-- ============================================================

BEGIN;

DO $$
DECLARE
  f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    WHERE p.proname IN ('update_updated_at_column', 'create_deal_for_new_contact', 'sync_deal_title_on_contact_name_change', 'auto_manage_chat_tags', 'seed_automation_templates')
      AND p.pronamespace IN ('public'::regnamespace, 'wacrm'::regnamespace)
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = wacrm, public, extensions, pg_temp', f.sig);
  END LOOP;
END $$;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('328_trigger_functions_search_path') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
