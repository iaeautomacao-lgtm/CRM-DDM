-- Migration 170: RLS nas tabelas expostas ao anon + RPCs SECURITY DEFINER com checagem de conta
-- (auditoria A-1 e A-9). APLICAR MANUALMENTE no Supabase SQL Editor.
-- Ordem: pode ser aplicada ANTES ou DEPOIS do deploy — o app não muda; só passam a
-- valer as restrições que o código já assume (acesso por service role no servidor).
--
-- PRÉ-CHECK (rodar antes; confirma o estado live, não confie nos arquivos de migration):
--   SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'wacrm' AND c.relname IN ('system_logs','page_views','user_sessions',
--      'disparador_utm_links','contact_import_variables','knowledge_base_files');
--   SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
--    WHERE table_schema = 'wacrm' AND grantee = 'anon'
--      AND table_name IN ('system_logs','page_views','user_sessions','disparador_utm_links',
--        'contact_import_variables','knowledge_base_files');
--   SELECT p.proname, p.prosecdef, p.proconfig, pg_get_function_identity_arguments(p.oid)
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'wacrm' AND p.proname IN ('move_stale_deals','run_all_deal_aging_rules',
--      'seed_tabulacao_tags','increment_unread_count','increment_session_page_count');
--
-- Quem usa o quê (verificado no src):
--   system_logs / page_views / user_sessions: só servidor (service role) — logger, /api/telemetry,
--     /api/feedback, /api/ddm-logs. Sem policy: authenticated/anon não leem nem escrevem.
--   contact_import_variables: navegador só LÊ (contact-detail-view); escrita só no servidor.
--   disparador_utm_links: navegador lê/apaga/insere (campaign-wizard); servidor faz relink.
--   knowledge_base_files: navegador lê/escreve (ai-agent-settings); servidor lê (responder).
--   run_all_deal_aging_rules: navegador (pipelines, deals-settings, pipeline-automations).
--   move_stale_deals, seed_tabulacao_tags, increment_*: só servidor / trigger SECURITY DEFINER.

BEGIN;

-- ============================================================
-- A-1.a Tabelas só de servidor: RLS ligada, sem policy, sem acesso de anon/authenticated.
-- ============================================================
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['system_logs', 'page_views', 'user_sessions'] LOOP
    IF to_regclass('wacrm.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE wacrm.%I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON wacrm.%I FROM PUBLIC, anon, authenticated', t);
      EXECUTE format('GRANT ALL ON wacrm.%I TO service_role', t);
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- A-1.b contact_import_variables: membro lê pelo contato; escrita só servidor.
-- ============================================================
ALTER TABLE wacrm.contact_import_variables ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.contact_import_variables FROM PUBLIC, anon, authenticated;
GRANT SELECT ON wacrm.contact_import_variables TO authenticated;
GRANT ALL ON wacrm.contact_import_variables TO service_role;

DROP POLICY IF EXISTS contact_import_variables_select ON wacrm.contact_import_variables;
CREATE POLICY contact_import_variables_select ON wacrm.contact_import_variables
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM wacrm.contacts c
    WHERE c.id = contact_import_variables.contact_id
      AND wacrm.is_account_member(c.account_id)
  ));

-- ============================================================
-- A-1.c disparador_utm_links: não tinha account_id. Passa a ter, preenchido pela
-- conta do usuário logado (DEFAULT) — o navegador continua inserindo sem mandar a coluna.
-- Linhas inseridas pelo servidor (service role) ficam sem conta e só o servidor as enxerga.
-- ============================================================
CREATE OR REPLACE FUNCTION wacrm.current_account_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = wacrm, public
AS $$
  SELECT p.account_id FROM wacrm.profiles p WHERE p.user_id = auth.uid() LIMIT 1;
$$;
REVOKE ALL ON FUNCTION wacrm.current_account_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.current_account_id() TO authenticated, service_role;

ALTER TABLE wacrm.disparador_utm_links
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES wacrm.accounts(id) ON DELETE CASCADE;
ALTER TABLE wacrm.disparador_utm_links
  ALTER COLUMN account_id SET DEFAULT wacrm.current_account_id();

UPDATE wacrm.disparador_utm_links u
SET account_id = c.account_id
FROM wacrm.campaigns c
WHERE u.campaign_id = c.id AND u.account_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_disparador_utm_links_account
  ON wacrm.disparador_utm_links (account_id);

ALTER TABLE wacrm.disparador_utm_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON wacrm.disparador_utm_links FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.disparador_utm_links TO authenticated;
GRANT ALL ON wacrm.disparador_utm_links TO service_role;

DROP POLICY IF EXISTS disparador_utm_links_all ON wacrm.disparador_utm_links;
CREATE POLICY disparador_utm_links_all ON wacrm.disparador_utm_links
  FOR ALL TO authenticated
  USING (wacrm.is_account_member(account_id))
  WITH CHECK (wacrm.is_account_member(account_id));

-- ============================================================
-- A-1.d knowledge_base_files: criada em produção sem migration; só protege se existir
-- e tiver account_id. Leitura por membro; escrita por agent+ (UI de configuração da IA).
-- ============================================================
DO $$
BEGIN
  IF to_regclass('wacrm.knowledge_base_files') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'wacrm' AND table_name = 'knowledge_base_files'
         AND column_name = 'account_id'
     ) THEN
    EXECUTE 'ALTER TABLE wacrm.knowledge_base_files ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON wacrm.knowledge_base_files FROM PUBLIC, anon';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON wacrm.knowledge_base_files TO authenticated';
    EXECUTE 'GRANT ALL ON wacrm.knowledge_base_files TO service_role';
    EXECUTE 'DROP POLICY IF EXISTS knowledge_base_files_select ON wacrm.knowledge_base_files';
    EXECUTE 'CREATE POLICY knowledge_base_files_select ON wacrm.knowledge_base_files
      FOR SELECT TO authenticated USING (wacrm.is_account_member(account_id))';
    EXECUTE 'DROP POLICY IF EXISTS knowledge_base_files_write ON wacrm.knowledge_base_files';
    EXECUTE 'CREATE POLICY knowledge_base_files_write ON wacrm.knowledge_base_files
      FOR ALL TO authenticated
      USING (wacrm.is_account_member(account_id, ''agent''))
      WITH CHECK (wacrm.is_account_member(account_id, ''agent''))';
  END IF;
END $$;

-- ============================================================
-- A-9 RPCs SECURITY DEFINER.
-- ============================================================

-- move_stale_deals: só era chamada por run_all_deal_aging_rules (definer). Sem checagem de
-- conta, então deixa de ser chamável pelo cliente.
CREATE OR REPLACE FUNCTION wacrm.move_stale_deals(
  p_source_stage_id UUID,
  p_target_stage_id UUID,
  p_days_limit INT
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_updated_count INT;
BEGIN
  UPDATE wacrm.deals
  SET stage_id = p_target_stage_id,
      updated_at = NOW()
  WHERE stage_id = p_source_stage_id
    AND status = 'open'
    AND updated_at < NOW() - (p_days_limit || ' days')::INTERVAL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.move_stale_deals(uuid, uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.move_stale_deals(uuid, uuid, int) TO service_role;

-- run_all_deal_aging_rules: continua chamável pelo navegador, mas só para a própria conta,
-- e só move deals da própria conta (antes movia por stage_id, de qualquer tenant).
CREATE OR REPLACE FUNCTION wacrm.run_all_deal_aging_rules(p_account_id UUID)
RETURNS TABLE (
  rule_id UUID,
  moved_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = wacrm, public
AS $$
DECLARE
  v_rule RECORD;
  v_moved INT;
BEGIN
  IF NOT wacrm.is_account_member(p_account_id) THEN
    RAISE EXCEPTION 'Acesso negado à conta' USING ERRCODE = '42501';
  END IF;

  FOR v_rule IN
    SELECT r.id, r.source_stage_id, r.target_stage_id, r.days_limit
    FROM wacrm.deal_aging_rules r
    WHERE r.account_id = p_account_id
  LOOP
    UPDATE wacrm.deals d
    SET stage_id = v_rule.target_stage_id,
        updated_at = NOW()
    WHERE d.account_id = p_account_id
      AND d.stage_id = v_rule.source_stage_id
      AND d.status = 'open'
      AND d.updated_at < NOW() - (v_rule.days_limit || ' days')::INTERVAL;

    GET DIAGNOSTICS v_moved = ROW_COUNT;

    rule_id := v_rule.id;
    moved_count := v_moved;
    RETURN NEXT;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION wacrm.run_all_deal_aging_rules(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION wacrm.run_all_deal_aging_rules(uuid) TO authenticated, service_role;

-- seed_tabulacao_tags: chamada só pelo trigger de accounts (definer, dono postgres) e
-- pelo backfill da 041. Sem checagem de conta -> fecha para clientes e fixa search_path.
ALTER FUNCTION wacrm.seed_tabulacao_tags(uuid, uuid) SET search_path = wacrm, public;
REVOKE ALL ON FUNCTION wacrm.seed_tabulacao_tags(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.seed_tabulacao_tags(uuid, uuid) TO service_role;

-- increment_unread_count / increment_session_page_count: só webhooks e /api/telemetry
-- (service role). Fechadas para anon/authenticated (a primeira não validava a conta).
REVOKE ALL ON FUNCTION wacrm.increment_unread_count(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.increment_unread_count(uuid) TO service_role;
REVOKE ALL ON FUNCTION wacrm.increment_session_page_count(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.increment_session_page_count(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
