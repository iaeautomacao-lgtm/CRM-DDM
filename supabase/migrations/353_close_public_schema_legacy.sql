-- ============================================================
-- 353_close_public_schema_legacy.sql   (revisão de segurança 13/10 — achado do banco vivo, aprovado pelo dono)
--
-- O schema `public` tem tabelas e views ANTIGAS que o CRM não usa (zero referências no código): acordos, acordos_formalizados,
-- agendamentos, call_analytics, calls, campaign_contacts, campaign_contacts2, campaigns, contact_phones, contacts, contacts2,
-- formalizacao_acordos, app_settings, system_logs e as views vw_* (KPIs de acordos, histórico de ligações, relatórios).
-- No banco vivo: o anon tinha TODAS as permissões nelas, várias tinham a policy "Enable all access for all users" (USING true)
-- e as views rodavam como o dono (sem security_invoker), passando por cima da RLS. Com a chave anon (pública, vai no JS do site)
-- qualquer pessoa lia, alterava e apagava esses dados.
--
-- O QUE FAZ (NÃO apaga dado nenhum):
--   1. REVOKE ALL de anon e authenticated em TODA tabela/view/sequência do schema public (exceto objetos de extensão).
--   2. DROP das policies "Enable all access for all users", "Enable insert access for all users" e "Enable read access for all users".
--   3. Views do public passam a security_invoker = true (respeitam a RLS de quem consulta).
--   O service_role (servidor) continua com acesso total. O schema wacrm não é tocado.
--
-- PRÉ-CHECK (só leitura; guarde o resultado — é o "antes" para o rollback manual, se precisar):
--   SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) FROM information_schema.role_table_grants
--    WHERE grantee IN ('anon','authenticated') AND table_schema = 'public' GROUP BY 1 ORDER BY 1;
--   SELECT tablename, policyname, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname = 'public' ORDER BY 1,2;
-- VERIFICAÇÃO: as duas consultas acima voltam vazias (sem grants a anon/authenticated e sem as policies "all access").
-- ORDEM: independente; antes ou depois do deploy (o app não usa essas tabelas). Idempotente.
-- SE ALGUM SISTEMA EXTERNO RECLAMAR (ex.: um app antigo de acordos/ligações que usava a chave anon), rode o ROLLBACK abaixo:
-- ROLLBACK:   BEGIN;
--             DO $rb$ DECLARE r record; BEGIN
--               FOR r IN SELECT c.oid::regclass AS obj FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--                         WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
--                           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e') LOOP
--                 EXECUTE format('GRANT ALL ON %s TO anon, authenticated', r.obj);
--               END LOOP;
--               FOR r IN SELECT c.oid::regclass AS obj FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--                         WHERE n.nspname = 'public' AND c.relkind IN ('v','m')
--                           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e') LOOP
--                 EXECUTE format('ALTER VIEW %s RESET (security_invoker)', r.obj);
--               END LOOP;
--             END $rb$;
--             GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
--             DO $rb$ DECLARE t text; BEGIN
--               FOREACH t IN ARRAY ARRAY['app_settings','calls','campaign_contacts','campaigns','contact_phones'] LOOP
--                 IF to_regclass('public.' || t) IS NOT NULL THEN
--                   EXECUTE format('CREATE POLICY "Enable all access for all users" ON public.%I FOR ALL USING (true) WITH CHECK (true)', t);
--                 END IF;
--               END LOOP;
--               IF to_regclass('public.system_logs') IS NOT NULL THEN
--                 CREATE POLICY "Enable insert access for all users" ON public.system_logs FOR INSERT WITH CHECK (true);
--                 CREATE POLICY "Enable read access for all users" ON public.system_logs FOR SELECT USING (true);
--               END IF;
--             END $rb$;
--             DELETE FROM wacrm.schema_migrations WHERE version = '353_close_public_schema_legacy';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
DECLARE
  r record;
BEGIN
  -- 1) Sem acesso de anon/authenticated a nenhuma tabela, view ou visão materializada do public (fora objetos de extensão).
  FOR r IN
    SELECT c.oid::regclass AS obj
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p', 'v', 'm')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM anon, authenticated', r.obj);
  END LOOP;

  -- 3) Views respeitam a RLS de quem consulta.
  FOR r IN
    SELECT c.oid::regclass AS obj
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('v', 'm')
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('ALTER VIEW %s SET (security_invoker = true)', r.obj);
  END LOOP;

  -- 2) Policies "acesso para todos".
  FOR r IN
    SELECT tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND policyname IN ('Enable all access for all users', 'Enable insert access for all users', 'Enable read access for all users')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', r.policyname, r.tablename);
  END LOOP;
END $$;

-- Sequências do public também fechadas para anon/authenticated.
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('353_close_public_schema_legacy') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
