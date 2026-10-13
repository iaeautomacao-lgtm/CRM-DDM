-- ============================================================
-- 346_api_keys_ai_config_select_has_perm.sql   (revisão de segurança 13/10 — RLS fase 3, item 5 do Sextante; equivalência EXATA nos papéis de sistema)
--
--   wacrm.api_keys   api_keys_select   era "membro da conta"  →  + has_perm('api_keys.view')   (concedida a TODOS os papéis de sistema: nada muda para eles)
--   wacrm.ai_config  ai_config_select  era "membro da conta"  →  + (has_perm('ai.config') OR has_perm('account.view'))
--       O navegador só lê id/account_id/enabled (GRANT por coluna da 200; a tela de visão geral mostra "IA ligada/desligada" a TODOS os papéis). `account.view` é de todos os
--       papéis de sistema ⇒ eles continuam vendo o indicador; `ai.config` (admin+) cobre o papel personalizado que configura a IA. Papel personalizado sem nenhuma das duas deixa de ler.
--   As colunas secretas (api_key etc.) já são fechadas ao navegador pela 200 e key_hash nunca é selecionado pelo painel; esta migration só fecha a LINHA por permissão.
--
-- SEGURANÇA DA TROCA: has_perm é fail-closed (perfil sem role_id = false) → a migration ABORTA, sem alterar nada, se houver perfil sem role_id.
--
-- PRÉ-CHECK:  SELECT count(*) FROM wacrm.profiles WHERE role_id IS NULL;                                                         -- 0 (senão aborta)
--             SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'wacrm' AND tablename IN ('api_keys','ai_config') ORDER BY 1,2;
--             SELECT key FROM wacrm.permission_catalog WHERE key IN ('api_keys.view','ai.config','account.view');                -- 3 linhas
-- VERIFICAÇÃO: como operador (JWT), SELECT count(*) FROM wacrm.api_keys → igual a antes; Configurações → visão geral continua mostrando o estado da IA.
-- ORDEM: antes ou depois do deploy (o app não depende dela). Idempotente.
-- ROLLBACK:   BEGIN;
--             DROP POLICY IF EXISTS api_keys_select ON wacrm.api_keys;
--             CREATE POLICY api_keys_select ON wacrm.api_keys FOR SELECT USING (wacrm.is_account_member(account_id));
--             DROP POLICY IF EXISTS ai_config_select ON wacrm.ai_config;
--             CREATE POLICY ai_config_select ON wacrm.ai_config FOR SELECT USING (wacrm.is_account_member(account_id));
--             DELETE FROM wacrm.schema_migrations WHERE version = '346_api_keys_ai_config_select_has_perm';
--             COMMIT;
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_orphans integer;
BEGIN
  IF to_regprocedure('wacrm.has_perm(text)') IS NULL THEN
    RAISE EXCEPTION '346: falta wacrm.has_perm(text) (migration 241)';
  END IF;
  IF (SELECT count(*) FROM wacrm.permission_catalog WHERE key IN ('api_keys.view', 'ai.config', 'account.view')) <> 3 THEN
    RAISE EXCEPTION '346: faltam chaves no catálogo (api_keys.view, ai.config, account.view — migration 240)';
  END IF;
  IF to_regclass('wacrm.api_keys') IS NULL OR to_regclass('wacrm.ai_config') IS NULL THEN
    RAISE EXCEPTION '346: falta wacrm.api_keys ou wacrm.ai_config — confira o schema vivo';
  END IF;
  SELECT count(*) INTO v_orphans FROM wacrm.profiles WHERE role_id IS NULL;
  IF v_orphans > 0 THEN
    RAISE EXCEPTION '346: % perfil(is) sem role_id perderiam estas leituras (has_perm é fail-closed) — preencha o role_id antes. Nada foi alterado.', v_orphans;
  END IF;
END $$;

DROP POLICY IF EXISTS api_keys_select ON wacrm.api_keys;
CREATE POLICY api_keys_select ON wacrm.api_keys FOR SELECT USING (
  wacrm.is_account_member(account_id) AND (SELECT wacrm.has_perm('api_keys.view'))
);

DROP POLICY IF EXISTS ai_config_select ON wacrm.ai_config;
CREATE POLICY ai_config_select ON wacrm.ai_config FOR SELECT USING (
  wacrm.is_account_member(account_id) AND ((SELECT wacrm.has_perm('ai.config')) OR (SELECT wacrm.has_perm('account.view')))
);

DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('346_api_keys_ai_config_select_has_perm') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
