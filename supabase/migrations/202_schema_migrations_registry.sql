-- ============================================================
-- 202_schema_migrations_registry.sql   (PRD 15, 15.3 — o banco diz o que foi aplicado)
--
-- PROBLEMA: as migrations são aplicadas à mão no SQL Editor, às vezes várias juntas; uma com CREATE INDEX CONCURRENTLY
-- abortou TUDO (25001) e só descobrimos com consultas manuais (to_regclass/to_regprocedure). Não havia registro.
--
-- O QUE FAZ:
--   1. wacrm.schema_migrations — uma linha por migration aplicada: version (nome do arquivo sem .sql), applied_at,
--      applied_by, source ('migration' = a própria migration se registrou; 'backfill' = DETECTADA por esta 202) e
--      checksum (opcional, hoje sempre NULL). RLS ligada e fechada: só service_role (nenhuma policy; anon/authenticated
--      sem privilégio algum).
--   2. wacrm.schema_check_report() — RPC SECURITY DEFINER (só service_role) que devolve {applied:[versões], indexes:[{name,valid}]}.
--      É o que `npm run schema:check` (scripts/schema-check.mjs) lê; os índices vêm de pg_index (indisvalid), pois um
--      CREATE INDEX CONCURRENTLY interrompido deixa um índice INVÁLIDO que nenhuma tabela de registro enxerga.
--   3. BACKFILL POR DETECÇÃO (abaixo): para cada migration >= 183 do repositório, uma verificação objetiva do que ela cria
--      (tabela, função, coluna, índice válido, policy, CHECK, privilégio de coluna). Só registra a que DE FATO está no banco.
--      Migration parcialmente aplicada NÃO é registrada (todas as condições precisam valer). Ver o mapa na seção do backfill.
--      Migrations anteriores à 183 não são rastreadas (o schema:check exige >= 183).
--
-- DAQUI PARA FRENTE: toda migration nova com BEGIN/COMMIT termina com
--   DO $$ BEGIN IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
--     INSERT INTO wacrm.schema_migrations (version) VALUES ('<nome do arquivo sem .sql>') ON CONFLICT DO NOTHING;
--   END IF; END $$;
-- dentro da transação (o IF deixa a migration rodar mesmo se a 202 ainda não foi aplicada). As migrations "b" com
-- CREATE INDEX CONCURRENTLY NÃO se registram (não podem estar em transação): o schema:check as detecta pelo índice.
-- Regra completa e modelo: supabase/migrations/_MODELO.md.
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT to_regclass('wacrm.schema_migrations');                       -- NULL na primeira vez
--   SELECT to_regclass('wacrm.accounts'), to_regclass('wacrm.profiles');  -- não nulos (schema wacrm vivo)
-- VERIFICAÇÃO (depois):
--   SELECT version, source, applied_at FROM wacrm.schema_migrations ORDER BY version;
--   -- confira com o que VOCÊ sabe que foi aplicado; o que faltar: rode a migration (ela se registra sozinha)
--   SELECT wacrm.schema_check_report();
-- ORDEM: antes ou depois do deploy (nada no app depende dela). Idempotente (backfill só insere o que falta).
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS wacrm.schema_check_report();
--   DROP TABLE IF EXISTS wacrm.schema_migrations;
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL OR to_regclass('wacrm.profiles') IS NULL THEN
    RAISE EXCEPTION '202: schema wacrm sem accounts/profiles — confira o schema vivo';
  END IF;
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'wacrm' AND table_name = 'schema_migrations' AND column_name = 'applied_at'
  ) THEN
    RAISE EXCEPTION '202: wacrm.schema_migrations já existe com outro formato — nada foi alterado';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.schema_migrations (
  version    text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by text NOT NULL DEFAULT current_user,
  source     text NOT NULL DEFAULT 'migration' CHECK (source IN ('migration', 'backfill')),
  checksum   text
);

-- Tabela fechada: RLS ligada e NENHUMA policy; só service_role (que ignora a RLS).
ALTER TABLE wacrm.schema_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.schema_migrations FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE wacrm.schema_migrations TO service_role;

CREATE OR REPLACE FUNCTION wacrm.schema_check_report()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'applied', coalesce(
      (SELECT jsonb_agg(m.version ORDER BY m.version) FROM wacrm.schema_migrations m), '[]'::jsonb),
    'indexes', coalesce(
      (SELECT jsonb_agg(jsonb_build_object('name', c.relname, 'valid', i.indisvalid) ORDER BY c.relname)
         FROM pg_catalog.pg_index i
         JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'wacrm'), '[]'::jsonb)
  )
$$;
REVOKE ALL ON FUNCTION wacrm.schema_check_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.schema_check_report() TO service_role;

-- ---- BACKFILL POR DETECÇÃO ---------------------------------------------------------------------------------------
-- Auxiliares temporárias (somem no fim da sessão). Tudo por catálogo: nada aqui altera dado nem objeto de negócio.
CREATE OR REPLACE FUNCTION pg_temp.tbl(p_table text) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT to_regclass('wacrm.' || p_table) IS NOT NULL $$;

CREATE OR REPLACE FUNCTION pg_temp.fn(p_name text) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'wacrm' AND p.proname = p_name) $$;

CREATE OR REPLACE FUNCTION pg_temp.col(p_table text, p_column text) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                   WHERE a.attrelid = to_regclass('wacrm.' || p_table) AND a.attname = p_column
                     AND a.attnum > 0 AND NOT a.attisdropped) $$;

-- índice VÁLIDO (um CONCURRENTLY interrompido deixa indisvalid = false e NÃO conta)
CREATE OR REPLACE FUNCTION pg_temp.idx(p_name text) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_index i
                    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
                    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'wacrm' AND c.relname = p_name AND i.indisvalid) $$;

CREATE OR REPLACE FUNCTION pg_temp.policy(p_table text, p_policy text) RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_policies
                   WHERE schemaname = 'wacrm' AND tablename = p_table AND policyname = p_policy) $$;

-- authenticated TEM SELECT na coluna? (NULL-safe: sem o papel ou sem a tabela devolve NULL → tratado como "não sei")
CREATE OR REPLACE FUNCTION pg_temp.auth_can_select(p_table text, p_column text) RETURNS boolean LANGUAGE plpgsql STABLE AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN RETURN NULL; END IF;
  IF to_regclass('wacrm.' || p_table) IS NULL OR NOT pg_temp.col(p_table, p_column) THEN RETURN NULL; END IF;
  RETURN has_column_privilege('authenticated', to_regclass('wacrm.' || p_table), p_column, 'SELECT');
END
$$;

-- nº de papéis de SISTEMA (SQL dinâmico: a tabela pode não existir e não pode quebrar a leitura do comando)
CREATE OR REPLACE FUNCTION pg_temp.system_roles() RETURNS integer LANGUAGE plpgsql STABLE AS
$$
DECLARE
  n integer;
BEGIN
  IF to_regclass('wacrm.account_roles') IS NULL THEN RETURN 0; END IF;
  EXECUTE 'SELECT count(*)::int FROM wacrm.account_roles WHERE account_id IS NULL' INTO n;
  RETURN n;
END
$$;

-- Mapa migration → o que ela cria (TODAS as condições precisam valer):
--   183 campaign_metric_deltas (tabela) + consolidate_campaign_metrics (função)
--   184 dispatch_campaign_moves (tabela) + try_acquire_cron_lock, renew_cron_lock, process_dispatch_campaign_moves (funções)
--   185 webhook_status_inbox (tabela) + ingest_status_events, apply_dispatch_statuses (funções)
--   186 CHECK de dispatch_channel_limits.max_in_flight com 150
--   187 coluna disp_message_queue.erro_codigo + função extract_meta_error_code      187b índice idx_dmq_erro_codigo (válido)
--   188 claim_dispatch_batch, confirm_dispatch_items_sent (funções)
--   189 dispatch_monitor_counts (função)                                              189b índice idx_dmq_session_agendado (válido)
--   190 tabelas dispatch_rate_policy, channel_health, dispatch_channel_rate, dispatch_channel_rate_history
--   191 dispatch_errors_summary (função)                                              191b índice idx_dmq_erro_updated (válido)
--   192 coluna dispatch_channel_limits.paused
--   193 colunas channel_health.verified_name e display_phone_number
--   194 coluna disp_message_queue.inflight_until + claim_dispatch_item_capped grava o lease 194b índice idx_dmq_enviando_inflight (válido)
--   200 policy ai_config_select + authenticated SEM select em ai_config.api_key
--   200b authenticated SEM select nos 4 segredos de whatsapp_config E com select em id
--   201 webhook_message_inbox (tabela) + ingest_message_events, claim_message_inbox (funções)
--   210 wakeable_flow_runs (função)      210b índice flow_runs_delayed_wake (válido)
--   211 stalled_ai_conversations (função)   211b índice idx_conversations_open_unassigned_customer_msg (válido)
--   212 flow_run_tool_results (tabela)
--   240 account_roles + permission_catalog + role_permissions (tabelas) + profiles.role_id + 5 papéis de sistema
--   241 has_perm, my_permissions, role_rank, compat_role_for (funções)                 241b índice idx_profiles_role_id (válido)
INSERT INTO wacrm.schema_migrations (version, source)
SELECT d.v, 'backfill'
  FROM (VALUES
    ('183_campaign_metric_deltas',
       pg_temp.tbl('campaign_metric_deltas') AND pg_temp.fn('consolidate_campaign_metrics')),
    ('184_dispatch_lock_pausa',
       pg_temp.tbl('dispatch_campaign_moves') AND pg_temp.fn('try_acquire_cron_lock') AND pg_temp.fn('renew_cron_lock')
       AND pg_temp.fn('process_dispatch_campaign_moves')),
    ('185_webhook_status_inbox',
       pg_temp.tbl('webhook_status_inbox') AND pg_temp.fn('ingest_status_events') AND pg_temp.fn('apply_dispatch_statuses')),
    ('186_dispatch_max_in_flight_150',
       EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                WHERE c.conrelid = to_regclass('wacrm.dispatch_channel_limits') AND c.contype = 'c'
                  AND pg_get_constraintdef(c.oid) LIKE '%150%')),
    ('187_disp_queue_erro_codigo',
       pg_temp.col('disp_message_queue', 'erro_codigo') AND pg_temp.fn('extract_meta_error_code')),
    ('187b_disp_queue_erro_codigo_index', pg_temp.idx('idx_dmq_erro_codigo')),
    ('188_dispatch_batch_claim_confirm',
       pg_temp.fn('claim_dispatch_batch') AND pg_temp.fn('confirm_dispatch_items_sent')),
    ('189_dispatch_monitor_counts', pg_temp.fn('dispatch_monitor_counts')),
    ('189b_disp_queue_session_agendado_index', pg_temp.idx('idx_dmq_session_agendado')),
    ('190_dispatch_rate_by_quality',
       pg_temp.tbl('dispatch_rate_policy') AND pg_temp.tbl('channel_health') AND pg_temp.tbl('dispatch_channel_rate')
       AND pg_temp.tbl('dispatch_channel_rate_history')),
    ('191_dispatch_errors_summary', pg_temp.fn('dispatch_errors_summary')),
    ('191b_disp_queue_erro_updated_index', pg_temp.idx('idx_dmq_erro_updated')),
    ('192_dispatch_channel_paused', pg_temp.col('dispatch_channel_limits', 'paused')),
    ('193_channel_health_name_phone',
       pg_temp.col('channel_health', 'verified_name') AND pg_temp.col('channel_health', 'display_phone_number')),
    ('194_dispatch_inflight_lease',
       pg_temp.col('disp_message_queue', 'inflight_until')
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'wacrm' AND p.proname = 'claim_dispatch_item_capped' AND p.prosrc ILIKE '%inflight_until%')),
    ('194b_dispatch_inflight_idx', pg_temp.idx('idx_dmq_enviando_inflight')),
    ('200_ai_config_secret_columns',
       pg_temp.policy('ai_config', 'ai_config_select') AND pg_temp.auth_can_select('ai_config', 'api_key') IS FALSE),
    ('200b_whatsapp_config_select_columns',
       pg_temp.auth_can_select('whatsapp_config', 'access_token') IS FALSE
       AND pg_temp.auth_can_select('whatsapp_config', 'app_secret') IS FALSE
       AND pg_temp.auth_can_select('whatsapp_config', 'verify_token') IS FALSE
       AND pg_temp.auth_can_select('whatsapp_config', 'waha_api_key') IS FALSE
       AND pg_temp.auth_can_select('whatsapp_config', 'id') IS TRUE),
    ('201_webhook_message_inbox',
       pg_temp.tbl('webhook_message_inbox') AND pg_temp.fn('ingest_message_events') AND pg_temp.fn('claim_message_inbox')),
    ('210_wakeable_flow_runs', pg_temp.fn('wakeable_flow_runs')),
    ('210b_flow_runs_wake_at_idx', pg_temp.idx('flow_runs_delayed_wake')),
    ('211_stalled_ai_conversations', pg_temp.fn('stalled_ai_conversations')),
    ('211b_conversations_stalled_idx', pg_temp.idx('idx_conversations_open_unassigned_customer_msg')),
    ('212_flow_run_tool_results', pg_temp.tbl('flow_run_tool_results')),
    ('240_roles_foundation',
       pg_temp.tbl('account_roles') AND pg_temp.tbl('permission_catalog') AND pg_temp.tbl('role_permissions')
       AND pg_temp.col('profiles', 'role_id')
       AND pg_temp.system_roles() = 5),
    ('241_roles_functions',
       pg_temp.fn('has_perm') AND pg_temp.fn('my_permissions') AND pg_temp.fn('role_rank') AND pg_temp.fn('compat_role_for')),
    ('241b_profiles_role_id_idx', pg_temp.idx('idx_profiles_role_id'))
  ) AS d(v, ok)
 WHERE d.ok IS TRUE
ON CONFLICT (version) DO NOTHING;

-- A própria 202 (as condições acima não a cobrem: ela acabou de criar a tabela).
INSERT INTO wacrm.schema_migrations (version, source) VALUES ('202_schema_migrations_registry', 'migration')
ON CONFLICT (version) DO NOTHING;

COMMIT;
NOTIFY pgrst, 'reload schema';
