-- ============================================================
-- 200b_whatsapp_config_select_columns.sql   (R-2 — segredos de canal legíveis pelo navegador)
--
-- PROBLEMA: a 153 tirou INSERT/UPDATE das colunas de segredo de wacrm.whatsapp_config do papel
-- `authenticated`, mas deixou o SELECT da tabela inteira. Qualquer membro da conta (inclusive `viewer`) lê
-- access_token, app_secret, verify_token e waha_api_key direto pelo PostgREST (GET /rest/v1/whatsapp_config
-- ?select=*). Onde o valor é texto puro legado (a 153 admite isso), o segredo é utilizável: forja o HMAC do
-- webhook da Meta ou usa a chave do WAHA.
--
-- O QUE FAZ: tira de anon/authenticated o SELECT da tabela inteira e devolve ao `authenticated` o SELECT de
-- TODAS as colunas EXCETO os 4 segredos (lista calculada no momento da aplicação, então colunas que só existem
-- no banco vivo também entram). A RLS (visibilidade por conta/equipe) continua valendo. UPDATE por coluna
-- (flow_id, receptivo, habilitado, team_id, client_id — 153) e DELETE (RLS admin) não mudam.
--
-- ATENÇÃO — leitura COM segredo agora é só do servidor. Com GRANT por coluna, `select('*')` no cliente de
-- SESSÃO falha. As rotas que precisavam do segredo passam por src/lib/whatsapp/channel-config.ts (visibilidade
-- pela RLS do usuário + leitura pelo service role). Faça o deploy desse código ANTES desta migration (ou junto):
-- código novo + banco antigo funciona; código antigo + banco novo quebra o envio/QR/templates.
--
-- PRÉ-CHECK (rodar ANTES e guardar o resultado — base do rollback):
--   SELECT policyname, cmd, roles, qual FROM pg_policies WHERE schemaname = 'wacrm' AND tablename = 'whatsapp_config';
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema = 'wacrm' AND table_name = 'whatsapp_config' AND grantee IN ('anon','authenticated');
--   SELECT grantee, column_name, privilege_type FROM information_schema.column_privileges
--    WHERE table_schema = 'wacrm' AND table_name = 'whatsapp_config' AND grantee IN ('anon','authenticated')
--      AND privilege_type IN ('INSERT','UPDATE');   -- esperado: só UPDATE em flow_id/receptivo/habilitado/team_id/client_id
--   -- Funções INVOKER/views que leiam whatsapp_config com o papel do usuário (podem quebrar):
--   SELECT n.nspname, p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE NOT p.prosecdef AND pg_get_functiondef(p.oid) ILIKE '%whatsapp_config%' AND n.nspname IN ('wacrm','public');
--   SELECT schemaname, viewname FROM pg_views WHERE definition ILIKE '%whatsapp_config%' AND schemaname IN ('wacrm','public');
--
-- Idempotente — pode rodar mais de uma vez.
--
-- ROLLBACK (reabre a leitura dos segredos ao navegador; só em emergência):
--   GRANT SELECT ON TABLE wacrm.whatsapp_config TO authenticated;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.whatsapp_config') IS NULL THEN
    RAISE EXCEPTION '200b: wacrm.whatsapp_config não existe';
  END IF;
  -- As 4 colunas de segredo precisam existir com esses nomes; senão a lista abaixo não protege nada.
  IF (SELECT count(*) FROM pg_attribute
       WHERE attrelid = 'wacrm.whatsapp_config'::regclass AND NOT attisdropped
         AND attname IN ('access_token', 'app_secret', 'verify_token', 'waha_api_key')) <> 4 THEN
    RAISE EXCEPTION '200b: esperava as colunas access_token, app_secret, verify_token e waha_api_key em whatsapp_config — confira o schema vivo';
  END IF;
END $$;

-- anon não tem uso legítimo (a RLS exige auth.uid()): sem nenhum privilégio.
REVOKE ALL ON TABLE wacrm.whatsapp_config FROM anon;

-- Um GRANT na tabela prevalece sobre as permissões por coluna: tira o SELECT de tabela inteira.
REVOKE SELECT ON TABLE wacrm.whatsapp_config FROM authenticated;

DO $$
DECLARE
  v_all     text;
  v_allowed text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
    INTO v_all
    FROM pg_attribute
   WHERE attrelid = 'wacrm.whatsapp_config'::regclass AND attnum > 0 AND NOT attisdropped;

  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
    INTO v_allowed
    FROM pg_attribute
   WHERE attrelid = 'wacrm.whatsapp_config'::regclass AND attnum > 0 AND NOT attisdropped
     AND attname NOT IN ('access_token', 'app_secret', 'verify_token', 'waha_api_key');

  -- Limpa SELECT por coluna anterior (idempotência) e concede só o permitido.
  EXECUTE format('REVOKE SELECT (%s) ON wacrm.whatsapp_config FROM authenticated', v_all);
  EXECUTE format('GRANT SELECT (%s) ON wacrm.whatsapp_config TO authenticated', v_allowed);
END $$;

-- O servidor segue com tudo.
GRANT ALL ON TABLE wacrm.whatsapp_config TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
