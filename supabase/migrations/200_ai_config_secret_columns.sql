-- ============================================================
-- 200_ai_config_secret_columns.sql   (R-1 — chaves de IA legíveis/graváveis pelo navegador)
--
-- PROBLEMA: wacrm.ai_config tem a policy "Users can manage own AI config" FOR ALL só por membro da conta
-- (031). Qualquer membro — inclusive `viewer` — lia e GRAVAVA a tabela direto pelo PostgREST com a sessão
-- dele: api_key / elevenlabs_api_key (a OpenAI/ElevenLabs da conta), system_prompt, enabled. A restrição por
-- papel (admin) existe só na rota /api/account/ai-config; o banco seguia aberto. Linhas antigas guardam a
-- chave em TEXTO PURO (084) — segredo utilizável por quem as lê.
--
-- O QUE FAZ:
--   1) troca a policy FOR ALL por uma policy de SELECT por membro da conta (sem escrita);
--   2) tira de anon/authenticated qualquer escrita e o SELECT de tabela inteira; o `authenticated` volta a
--      ler só id, account_id e enabled — o ÚNICO uso do navegador (settings-overview.tsx: select('enabled'));
--   3) api_key, elevenlabs_api_key, api_provider e system_prompt ficam SÓ para o servidor (service_role).
-- Toda leitura/escrita real já passa por rotas/libs com service role (account/ai-config, flows/*, responder,
-- llm-shared, sentiment, acordo-tagging, intelligence/chat).
--
-- DEPOIS desta migration, rodar (uma vez): node scripts/encrypt-plaintext-ai-keys.mjs --apply
-- (cifra as chaves antigas em texto puro; dry-run por padrão).
--
-- PRÉ-CHECK (rodar ANTES e guardar o resultado — serve de base do rollback):
--   SELECT policyname, cmd, roles, qual, with_check FROM pg_policies
--    WHERE schemaname = 'wacrm' AND tablename = 'ai_config';
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema = 'wacrm' AND table_name = 'ai_config' AND grantee IN ('anon','authenticated');
--   SELECT grantee, column_name, privilege_type FROM information_schema.column_privileges
--    WHERE table_schema = 'wacrm' AND table_name = 'ai_config' AND grantee IN ('anon','authenticated');
--   -- esperado antes: policy FOR ALL por is_account_member; authenticated com ALL na tabela (herdado da 027).
--
-- ORDEM: pode rodar antes ou depois do deploy (nenhuma tela lê as colunas de segredo; as rotas usam service role).
-- Idempotente — pode rodar mais de uma vez.
--
-- ROLLBACK (só se algo legítimo quebrar; reabre a leitura/escrita pelo navegador):
--   BEGIN;
--   DROP POLICY IF EXISTS ai_config_select ON wacrm.ai_config;
--   CREATE POLICY "Users can manage own AI config" ON wacrm.ai_config FOR ALL
--     USING (wacrm.is_account_member(account_id));
--   GRANT ALL ON wacrm.ai_config TO authenticated;
--   COMMIT;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.ai_config') IS NULL THEN
    RAISE EXCEPTION '200: wacrm.ai_config não existe (migration 031)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'wacrm' AND p.proname = 'is_account_member'
  ) THEN
    RAISE EXCEPTION '200: wacrm.is_account_member não existe (migration 017/140)';
  END IF;
END $$;

ALTER TABLE wacrm.ai_config ENABLE ROW LEVEL SECURITY;

-- 1) Policy: leitura por membro; nenhuma policy de escrita (escrita só service_role).
DROP POLICY IF EXISTS "Users can manage own AI config" ON wacrm.ai_config;
DROP POLICY IF EXISTS ai_config_select ON wacrm.ai_config;
CREATE POLICY ai_config_select ON wacrm.ai_config FOR SELECT
  USING (wacrm.is_account_member(account_id));

-- 2) Grants. Um GRANT na tabela prevalece sobre as permissões por coluna: tira primeiro.
REVOKE ALL ON TABLE wacrm.ai_config FROM anon, authenticated;

-- Limpa grants por coluna anteriores (idempotência).
DO $$
DECLARE
  v_columns text;
BEGIN
  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
    INTO v_columns
    FROM pg_attribute
   WHERE attrelid = 'wacrm.ai_config'::regclass AND attnum > 0 AND NOT attisdropped;
  EXECUTE format(
    'REVOKE SELECT (%s), INSERT (%s), UPDATE (%s), REFERENCES (%s) ON wacrm.ai_config FROM anon, authenticated',
    v_columns, v_columns, v_columns, v_columns
  );
END $$;

-- 3) O navegador só precisa saber SE a IA está ligada (settings-overview.tsx).
GRANT SELECT (id, account_id, enabled) ON wacrm.ai_config TO authenticated;

-- O servidor segue com tudo.
GRANT ALL ON TABLE wacrm.ai_config TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
