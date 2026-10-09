-- ============================================================
-- 215_knowledge_vector.sql   (TASK1-D — RAG vetorial dos agentes, aprovado pelo dono em 09/10)
--
-- ⚠️ DONO: confira ANTES se a extensão vector (pgvector) está disponível neste projeto Supabase:
--     SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name = 'vector';
--   (painel: Database → Extensions → "vector"). Sem ela esta migration ABORTA sem mudar nada.
--
-- O QUE FAZ:
--   1. CREATE EXTENSION IF NOT EXISTS vector (no schema `extensions`, o padrão do Supabase, quando ele existe).
--   2. wacrm.knowledge_chunks: trechos dos arquivos de conhecimento com o embedding (vector(1536),
--      text-embedding-3-small). Conta, arquivo (FK com ON DELETE CASCADE: apagar o arquivo apaga os trechos),
--      ordem, texto. FECHADA: RLS ligada sem policy; só o service role (o navegador nunca lê nem grava).
--   3. Situação do índice por arquivo em wacrm.knowledge_base_files (214): embedding_status
--      (pending/indexed/no_key/failed/too_large; NULL = nunca indexado = "sem índice"), embedding_chunks,
--      embedding_model, embedded_at.
--   4. Custo: wacrm.ai_embedding_usage (conta × dia: textos enviados ao endpoint de embeddings e tokens cobrados) e
--      wacrm.ai_embedding_usage_add() (soma atômica). Só service role. Consulta do dono:
--        SELECT account_id, sum(embeddings) AS embeddings, sum(tokens) AS tokens FROM wacrm.ai_embedding_usage
--         WHERE day >= date_trunc('month', now())::date GROUP BY account_id ORDER BY tokens DESC;
--   5. wacrm.match_knowledge_chunks(conta, arquivos|NULL, embedding da consulta em texto, top_k, similaridade mínima):
--      os top_k trechos mais próximos por cosseno, SÓ da conta (e dos arquivos do agente). Só service role.
--      Com o índice HNSW da 215b, pede busca iterativa (pgvector ≥ 0.8) para o filtro por conta não "esvaziar" o top_k.
--   6. Descritor do perfil de agente (wacrm.ai_agent_schema_v1, da 177) com o campo OPCIONAL knowledge.vector
--      ({ enabled, top_k?, min_similarity? }). Versões existentes continuam válidas (o campo é opcional).
--
-- PRÉ-CHECK (rodar ANTES):
--   SELECT name, installed_version FROM pg_available_extensions WHERE name = 'vector';        -- 1 linha
--   SELECT to_regclass('wacrm.knowledge_base_files'), (SELECT count(*) FROM pg_proc WHERE proname = 'ai_agent_schema_v1');   -- não nulos (214, 177)
--   SELECT column_name FROM information_schema.columns WHERE table_schema = 'wacrm'
--      AND table_name = 'knowledge_base_files' AND column_name = 'char_count';                -- 1 (214)
-- VERIFICAÇÃO:
--   SELECT extversion FROM pg_extension WHERE extname = 'vector';
--   SELECT version FROM wacrm.schema_migrations WHERE version = '215_knowledge_vector';
-- ORDEM: depois da 214; ANTES do deploy da D (publicar agente com knowledge.vector exige o descritor novo). Depois,
--   a 215b SOZINHA. Sem a 215 o app segue no modo atual (a busca vetorial falha e cai no teto de caracteres).
-- ROLLBACK (o modo atual volta a valer sozinho):
--   DROP FUNCTION IF EXISTS wacrm.match_knowledge_chunks(uuid, uuid[], text, integer, double precision);
--   DROP FUNCTION IF EXISTS wacrm.ai_embedding_usage_add(uuid, integer, integer);
--   DROP TABLE IF EXISTS wacrm.knowledge_chunks; DROP TABLE IF EXISTS wacrm.ai_embedding_usage;
--   ALTER TABLE wacrm.knowledge_base_files DROP COLUMN IF EXISTS embedding_status, DROP COLUMN IF EXISTS embedding_chunks,
--     DROP COLUMN IF EXISTS embedding_model, DROP COLUMN IF EXISTS embedded_at;
--   (o descritor com knowledge.vector pode ficar: o campo é opcional.)
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
    RAISE EXCEPTION '215: a extensão vector (pgvector) não está disponível neste banco — habilite em Database → Extensions e rode de novo';
  END IF;
  IF to_regclass('wacrm.knowledge_base_files') IS NULL OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'wacrm' AND table_name = 'knowledge_base_files' AND column_name = 'char_count'
  ) THEN
    RAISE EXCEPTION '215: falta a migration 214 (wacrm.knowledge_base_files formalizada) — aplique a 214 antes';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
     WHERE i.indrelid = 'wacrm.knowledge_base_files'::regclass AND i.indisunique AND i.indnatts = 1
       AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'wacrm.knowledge_base_files'::regclass AND attname = 'id')
  ) THEN
    RAISE EXCEPTION '215: wacrm.knowledge_base_files.id sem chave única — confira o schema vivo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'wacrm' AND p.proname = 'ai_agent_schema_v1') THEN
    RAISE EXCEPTION '215: falta wacrm.ai_agent_schema_v1() (migration 177)';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'extensions') THEN
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions';
  ELSE
    EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector';
  END IF;
END $$;

-- O tipo vector mora no schema da extensão (extensions no Supabase).
SET LOCAL search_path = wacrm, extensions, public, pg_catalog;

-- 2) trechos
CREATE TABLE IF NOT EXISTS wacrm.knowledge_chunks (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid        NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  file_id        uuid        NOT NULL REFERENCES wacrm.knowledge_base_files(id) ON DELETE CASCADE,
  chunk_index    integer     NOT NULL CHECK (chunk_index >= 0),
  content        text        NOT NULL,
  token_estimate integer     NOT NULL DEFAULT 0,
  embedding      vector(1536) NOT NULL,
  model          text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_account_file ON wacrm.knowledge_chunks (account_id, file_id);

ALTER TABLE wacrm.knowledge_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.knowledge_chunks FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE wacrm.knowledge_chunks TO service_role;

-- 3) situação do índice por arquivo
ALTER TABLE wacrm.knowledge_base_files
  ADD COLUMN IF NOT EXISTS embedding_status text
    CHECK (embedding_status IN ('pending', 'indexed', 'no_key', 'failed', 'too_large')),
  ADD COLUMN IF NOT EXISTS embedding_chunks integer,
  ADD COLUMN IF NOT EXISTS embedding_model  text,
  ADD COLUMN IF NOT EXISTS embedded_at      timestamptz;

-- 4) custo (contagem simples por conta e dia)
CREATE TABLE IF NOT EXISTS wacrm.ai_embedding_usage (
  account_id uuid   NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  day        date   NOT NULL,
  embeddings bigint NOT NULL DEFAULT 0,
  tokens     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);
ALTER TABLE wacrm.ai_embedding_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wacrm.ai_embedding_usage FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE wacrm.ai_embedding_usage TO service_role;

CREATE OR REPLACE FUNCTION wacrm.ai_embedding_usage_add(p_account_id uuid, p_embeddings integer, p_tokens integer)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = wacrm, pg_catalog
AS $$
  INSERT INTO wacrm.ai_embedding_usage AS u (account_id, day, embeddings, tokens)
  VALUES (p_account_id, (now() AT TIME ZONE 'America/Sao_Paulo')::date, greatest(coalesce(p_embeddings, 0), 0), greatest(coalesce(p_tokens, 0), 0))
  ON CONFLICT (account_id, day) DO UPDATE
    SET embeddings = u.embeddings + EXCLUDED.embeddings, tokens = u.tokens + EXCLUDED.tokens
$$;
REVOKE ALL ON FUNCTION wacrm.ai_embedding_usage_add(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.ai_embedding_usage_add(uuid, integer, integer) TO service_role;

-- 5) busca
CREATE OR REPLACE FUNCTION wacrm.match_knowledge_chunks(
  p_account_id uuid,
  p_file_ids uuid[],
  p_query text,
  p_top_k integer,
  p_min_similarity double precision DEFAULT 0
)
RETURNS TABLE (file_id uuid, chunk_index integer, content text, similarity double precision)
LANGUAGE plpgsql
SET search_path = wacrm, extensions, public, pg_catalog
AS $$
#variable_conflict use_column
DECLARE
  q vector(1536);
BEGIN
  IF p_account_id IS NULL OR p_top_k IS NULL OR p_top_k < 1 OR p_top_k > 50 THEN
    RAISE EXCEPTION 'match_knowledge_chunks: argumentos inválidos' USING ERRCODE = '22023';
  END IF;
  q := p_query::vector(1536);
  -- Com o HNSW (215b) o filtro por conta vem DEPOIS da busca aproximada: mais candidatos e, no pgvector ≥ 0.8,
  -- busca iterativa até preencher o top_k. Sem o índice (ou conta pequena) o plano é exato pelo índice da conta.
  PERFORM set_config('hnsw.ef_search', '100', true);
  BEGIN
    PERFORM set_config('hnsw.iterative_scan', 'relaxed_order', true);
  EXCEPTION WHEN others THEN
    NULL;
  END;
  RETURN QUERY
    SELECT s.file_id, s.chunk_index, s.content, s.similarity
      FROM (
        SELECT c.file_id, c.chunk_index, c.content, (1 - (c.embedding <=> q))::double precision AS similarity
          FROM wacrm.knowledge_chunks c
         WHERE c.account_id = p_account_id
           AND (p_file_ids IS NULL OR c.file_id = ANY (p_file_ids))
         ORDER BY c.embedding <=> q
         LIMIT p_top_k
      ) s
     WHERE s.similarity >= coalesce(p_min_similarity, 0)
     ORDER BY s.similarity DESC;
END $$;
REVOKE ALL ON FUNCTION wacrm.match_knowledge_chunks(uuid, uuid[], text, integer, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.match_knowledge_chunks(uuid, uuid[], text, integer, double precision) TO service_role;

-- 6) descritor do perfil de agente (177) com knowledge.vector opcional — mesmo JSON de schema.ts (AGENT_CONFIG_SPEC),
--    conferido por agents/migration.sql.test.ts.
-- >>> descritor 215
CREATE OR REPLACE FUNCTION wacrm.ai_agent_schema_v1() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $schema$
  SELECT '{"type":"object","properties":{"schema_version":{"type":"number","values":[1]},"llm":{"type":"object","properties":{"provider":{"type":"string","values":["openai","gemini","claude","hermes"],"optional":true},"model":{"type":"string","optional":true},"temperature":{"type":"number","min":0,"max":2,"optional":true},"max_tokens":{"type":"number","integer":true,"min":1,"optional":true},"max_completion_tokens":{"type":"number","integer":true,"min":1,"optional":true},"max_output_tokens":{"type":"number","integer":true,"min":1,"optional":true},"reasoning_effort":{"type":"string","values":["none","minimal","low","medium","high","xhigh"],"optional":true},"top_p":{"type":"number","min":0,"max":1,"optional":true},"top_k":{"type":"number","integer":true,"min":1,"optional":true},"frequency_penalty":{"type":"number","min":-2,"max":2,"optional":true},"presence_penalty":{"type":"number","min":-2,"max":2,"optional":true},"seed":{"type":"number","integer":true,"optional":true},"stop":{"type":"array","items":{"type":"string"},"optional":true},"n":{"type":"number","integer":true,"min":1,"optional":true},"tool_choice":{"type":"string","values":["auto","none","required"],"optional":true},"parallel_tool_calls":{"type":"boolean","optional":true},"stream":{"type":"boolean","optional":true},"logprobs":{"type":"boolean","optional":true},"top_logprobs":{"type":"number","min":0,"optional":true},"response_format":{"type":"string","values":["text","json_object","json_schema"],"optional":true},"response_schema":{"type":"string","optional":true},"response_mime_type":{"type":"string","optional":true},"thinking_budget":{"type":"number","min":0,"optional":true},"safety_settings":{"type":"array","items":{"type":"string"},"optional":true},"search_enabled":{"type":"boolean","optional":true},"provider_routing":{"type":"array","items":{"type":"string"},"optional":true},"logit_bias":{"type":"object","additional":{"type":"number","min":-100,"max":100},"optional":true}}},"prompt":{"type":"object","properties":{"source":{"type":"string","values":["node","account","default"]},"account_content":{"type":"string"},"legacy_override_present":{"type":"boolean"}}},"behavior":{"type":"object","properties":{"mode":{"type":"string","values":["once","loop","takeover"]},"max_turns":{"type":"number","integer":true,"min":1,"optional":true},"herdar_contexto":{"type":"boolean","optional":true},"debounce_ms":{"type":"number","min":0,"optional":true},"standalone_debounce_threshold_ms":{"type":"number","min":0,"optional":true},"free_turns":{"type":"number","min":0,"optional":true},"free_media_types":{"type":"array","items":{"type":"string"},"optional":true},"ack_words":{"type":"array","items":{"type":"string"},"optional":true},"chain_policy":{"type":"string","optional":true},"exit_tags":{"type":"array","items":{"type":"string"},"optional":true},"handoff_policy":{"type":"string","optional":true},"disabled_policy":{"type":"string","values":["failure_exit_or_handoff"],"optional":true},"stall_seconds":{"type":"number","integer":true,"min":1,"optional":true},"stall_max_minutes":{"type":"number","integer":true,"min":1,"optional":true},"legacy_ben_auto_exit":{"type":"boolean","optional":true},"legacy_flow_controlled":{"type":"boolean","optional":true}}},"recovery":{"type":"object","properties":{"attempt_retries":{"type":"number","min":0,"optional":true},"attempt_delay_ms":{"type":"number","min":0,"optional":true},"empty_reply_retries":{"type":"number","min":0,"optional":true},"empty_reply_delay_ms":{"type":"number","min":0,"optional":true},"empty_reply_text":{"type":"string","optional":true},"integration_failure_text":{"type":"string","optional":true},"integration_failure_tag":{"type":"string","optional":true},"tool_max_attempts":{"type":"number","integer":true,"min":1,"optional":true},"tool_retry_names":{"type":"array","items":{"type":"string"},"optional":true},"tool_retry_methods":{"type":"array","items":{"type":"string"},"optional":true},"tool_backoff_ms":{"type":"number","min":0,"optional":true},"tool_backoff_cap_ms":{"type":"number","min":0,"optional":true},"retry_before_external_effect_only":{"type":"boolean","optional":true}}},"protections":{"type":"object","properties":{"anti_xingamento":{"type":"object","properties":{"enabled":{"type":"boolean"},"patterns":{"type":"array","items":{"type":"string"},"optional":true},"reply":{"type":"string","optional":true},"tag":{"type":"string","optional":true},"action":{"type":"string","optional":true}}},"anti_loop":{"type":"object","properties":{"enabled":{"type":"boolean"},"min_messages":{"type":"number","integer":true,"min":1,"optional":true},"window_seconds":{"type":"number","integer":true,"min":1,"optional":true},"future_tolerance_ms":{"type":"number","min":0,"optional":true},"action":{"type":"string","optional":true}}},"pedido_humano_contestacao":{"type":"object","properties":{"enabled":{"type":"boolean"},"patterns":{"type":"array","items":{"type":"string"},"optional":true},"reply":{"type":"string","optional":true},"tag":{"type":"string","optional":true},"action":{"type":"string","optional":true}}},"pessoa_errada":{"type":"object","properties":{"enabled":{"type":"boolean"},"patterns":{"type":"array","items":{"type":"string"},"optional":true},"reply":{"type":"string","optional":true},"tag":{"type":"string","optional":true},"action":{"type":"string","optional":true}}}}},"knowledge":{"type":"object","properties":{"selection_mode":{"type":"string","values":["legacy_account_all","explicit"]},"kb_enabled":{"type":"boolean","optional":true},"file_ids":{"type":"array","items":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"optional":true},"files":{"type":"array","optional":true,"items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$","optional":true},"name":{"type":"string"},"content_hash":{"type":"string","pattern":"^[a-f0-9]{64}$"}}}},"max_chars":{"type":"number","integer":true,"min":1,"optional":true},"query_customer_messages":{"type":"number","integer":true,"min":1,"optional":true},"ranking":{"type":"string","optional":true},"name_weight":{"type":"number","min":0,"optional":true},"body_weight":{"type":"number","min":0,"optional":true},"min_term_chars":{"type":"number","integer":true,"min":1,"optional":true},"stopwords":{"type":"array","items":{"type":"string"},"optional":true},"min_partial_chars":{"type":"number","min":0,"optional":true},"truncation_note":{"type":"string","optional":true},"rag_external":{"type":"object","properties":{"enabled":{"type":"boolean"},"url":{"type":"string","pattern":"^https://[^\\s]+$","optional":true},"credential":{"type":"string","pattern":"^\\{\\{cred\\.[A-Z][A-Z0-9_]{1,63}\\}\\}$","optional":true},"top_k":{"type":"number","integer":true,"min":1,"max":50,"optional":true},"timeout_ms":{"type":"number","integer":true,"min":1,"optional":true},"max_bytes":{"type":"number","integer":true,"min":1,"optional":true},"max_context_chars":{"type":"number","integer":true,"min":1,"optional":true},"max_redirects":{"type":"number","min":0,"optional":true},"retries":{"type":"number","min":0,"optional":true},"failure_policy":{"type":"string","values":["continue_without_rag"],"optional":true}}},"vector":{"type":"object","optional":true,"properties":{"enabled":{"type":"boolean"},"top_k":{"type":"number","integer":true,"min":1,"max":20,"optional":true},"min_similarity":{"type":"number","min":0,"max":1,"optional":true}}}}},"tools":{"type":"array","items":{"type":"object","properties":{"tool_id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$","optional":true},"enabled":{"type":"boolean"},"definition":{"type":"object","properties":{"name":{"type":"string"},"description":{"type":"string"},"parameters":{"type":"object","properties":{"type":{"type":"string","values":["object"]},"properties":{"type":"object","additional":{"type":"object","properties":{"type":{"type":"string"},"description":{"type":"string"},"enum":{"type":"array","items":{"type":"string"},"optional":true}}}},"required":{"type":"array","items":{"type":"string"},"optional":true}}},"http":{"type":"object","properties":{"url":{"type":"string"},"method":{"type":"string","values":["GET","POST","PUT","PATCH","DELETE"]},"headers":{"type":"object","additional":{"type":"string"},"optional":true},"body":{"type":"string","optional":true}}},"timeout_ms":{"type":"number","integer":true,"min":1000,"max":60000,"optional":true}},"optional":true}}}},"rules":{"type":"array","items":{"type":"object","properties":{"rule_version_id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"position":{"type":"number","integer":true,"min":0},"enabled":{"type":"boolean"},"content_hash":{"type":"string","pattern":"^[a-f0-9]{64}$"}}}},"media":{"type":"object","properties":{"multimodal_enabled":{"type":"boolean","optional":true},"image_policy":{"type":"string","optional":true},"placeholders_version":{"type":"string","optional":true},"stt":{"type":"object","optional":true,"properties":{"model":{"type":"string","optional":true},"language":{"type":"string","optional":true},"mime_type":{"type":"string","optional":true},"filename":{"type":"string","optional":true},"timeout_ms":{"type":"number","integer":true,"min":1,"optional":true}}},"voice":{"type":"object","optional":true,"properties":{"enabled":{"type":"boolean","optional":true},"voice_id":{"type":"string","optional":true},"model_id":{"type":"string","optional":true},"requested_model_id":{"type":"string","optional":true},"stability":{"type":"number","min":0,"max":1,"optional":true},"similarity_boost":{"type":"number","min":0,"max":1,"optional":true},"response_mode":{"type":"string","optional":true},"mime_type":{"type":"string","optional":true},"filename_extension":{"type":"string","optional":true},"timeout_ms":{"type":"number","integer":true,"min":1,"optional":true},"storage_bucket":{"type":"string","optional":true},"cache_control_seconds":{"type":"number","min":0,"optional":true},"failure_policy":{"type":"string","optional":true}}}}},"execution":{"type":"object","properties":{"llm_timeout_ms":{"type":"number","integer":true,"min":1,"optional":true},"tool_timeout_ms":{"type":"number","integer":true,"min":1,"optional":true},"tool_max_bytes":{"type":"number","integer":true,"min":1,"optional":true},"tool_max_redirects":{"type":"number","min":0,"optional":true},"max_tool_rounds":{"type":"number","integer":true,"min":1,"optional":true},"history_limit":{"type":"number","integer":true,"min":1,"optional":true},"history_scope":{"type":"string","optional":true},"inherit_result_chars":{"type":"number","integer":true,"min":1,"optional":true},"concurrency":{"type":"number","integer":true,"min":1,"optional":true},"queue_wait_ms":{"type":"number","integer":true,"min":1,"optional":true},"rate_limit_retries":{"type":"number","min":0,"optional":true},"rate_limit_max_wait_ms":{"type":"number","integer":true,"min":1,"optional":true},"rate_limit_base_ms":{"type":"number","min":0,"optional":true},"rate_limit_jitter_ms":{"type":"number","min":0,"optional":true},"queue_heartbeat_ms":{"type":"number","integer":true,"min":1,"optional":true},"heartbeat_fresh_ms":{"type":"number","integer":true,"min":1,"optional":true},"heartbeat_write_interval_ms":{"type":"number","integer":true,"min":1,"optional":true},"watchdog_batch":{"type":"number","integer":true,"min":1,"optional":true},"safe_fetch_timeout_ms":{"type":"number","integer":true,"min":1,"optional":true},"safe_fetch_max_bytes":{"type":"number","integer":true,"min":1,"optional":true},"safe_fetch_max_redirects":{"type":"number","min":0,"optional":true},"idempotency_policy":{"type":"string","optional":true},"ownership_policy":{"type":"string","optional":true},"tools_order_policy":{"type":"string","optional":true}}},"analysis":{"type":"object","optional":true,"properties":{"history_limit":{"type":"number","integer":true,"min":1,"optional":true},"timeout_ms":{"type":"number","integer":true,"min":1,"optional":true},"max_tokens":{"type":"number","integer":true,"min":1,"optional":true},"temperature":{"type":"number","min":0,"optional":true},"response_format":{"type":"string","optional":true},"reasoning_effort":{"type":"string","optional":true}}},"connections":{"type":"object","properties":{"llm":{"type":"object","optional":true,"properties":{"credential":{"type":"string","pattern":"^\\{\\{cred\\.[A-Z][A-Z0-9_]{1,63}\\}\\}$","optional":true},"platform_env":{"type":"array","items":{"type":"string","values":["OPENAI_API_KEY","GEMINI_API_KEY","OPENROUTER_API_KEY","CLAUDE_API_KEY","ANTHROPIC_API_KEY","DDM_ACORDOS_API_TOKEN","DDM_TOKEN","DDM_API_KEY"]},"optional":true},"endpoint":{"type":"string","values":["https://api.openai.com/v1/chat/completions","https://generativelanguage.googleapis.com/v1beta/models/:model:generateContent","https://api.anthropic.com/v1/messages","https://openrouter.ai/api/v1/chat/completions","https://api.openai.com/v1/audio/transcriptions","https://api.elevenlabs.io/v1/text-to-speech/:voice_id","https://ddmacordos.com"],"optional":true},"headers":{"type":"object","additional":{"type":"string","values":["application/json","2023-06-01","https://wacrm.vercel.app","WA CRM"]},"optional":true}}},"stt":{"type":"object","optional":true,"properties":{"credential":{"type":"string","pattern":"^\\{\\{cred\\.[A-Z][A-Z0-9_]{1,63}\\}\\}$","optional":true},"platform_env":{"type":"array","items":{"type":"string","values":["OPENAI_API_KEY","GEMINI_API_KEY","OPENROUTER_API_KEY","CLAUDE_API_KEY","ANTHROPIC_API_KEY","DDM_ACORDOS_API_TOKEN","DDM_TOKEN","DDM_API_KEY"]},"optional":true},"endpoint":{"type":"string","values":["https://api.openai.com/v1/chat/completions","https://generativelanguage.googleapis.com/v1beta/models/:model:generateContent","https://api.anthropic.com/v1/messages","https://openrouter.ai/api/v1/chat/completions","https://api.openai.com/v1/audio/transcriptions","https://api.elevenlabs.io/v1/text-to-speech/:voice_id","https://ddmacordos.com"],"optional":true},"headers":{"type":"object","additional":{"type":"string","values":["application/json","2023-06-01","https://wacrm.vercel.app","WA CRM"]},"optional":true}}},"tts":{"type":"object","optional":true,"properties":{"credential":{"type":"string","pattern":"^\\{\\{cred\\.[A-Z][A-Z0-9_]{1,63}\\}\\}$","optional":true},"platform_env":{"type":"array","items":{"type":"string","values":["OPENAI_API_KEY","GEMINI_API_KEY","OPENROUTER_API_KEY","CLAUDE_API_KEY","ANTHROPIC_API_KEY","DDM_ACORDOS_API_TOKEN","DDM_TOKEN","DDM_API_KEY"]},"optional":true},"endpoint":{"type":"string","values":["https://api.openai.com/v1/chat/completions","https://generativelanguage.googleapis.com/v1beta/models/:model:generateContent","https://api.anthropic.com/v1/messages","https://openrouter.ai/api/v1/chat/completions","https://api.openai.com/v1/audio/transcriptions","https://api.elevenlabs.io/v1/text-to-speech/:voice_id","https://ddmacordos.com"],"optional":true},"headers":{"type":"object","additional":{"type":"string","values":["application/json","2023-06-01","https://wacrm.vercel.app","WA CRM"]},"optional":true}}},"ddm":{"type":"object","optional":true,"properties":{"credential":{"type":"string","pattern":"^\\{\\{cred\\.[A-Z][A-Z0-9_]{1,63}\\}\\}$","optional":true},"platform_env":{"type":"array","items":{"type":"string","values":["OPENAI_API_KEY","GEMINI_API_KEY","OPENROUTER_API_KEY","CLAUDE_API_KEY","ANTHROPIC_API_KEY","DDM_ACORDOS_API_TOKEN","DDM_TOKEN","DDM_API_KEY"]},"optional":true},"endpoint":{"type":"string","values":["https://api.openai.com/v1/chat/completions","https://generativelanguage.googleapis.com/v1beta/models/:model:generateContent","https://api.anthropic.com/v1/messages","https://openrouter.ai/api/v1/chat/completions","https://api.openai.com/v1/audio/transcriptions","https://api.elevenlabs.io/v1/text-to-speech/:voice_id","https://ddmacordos.com"],"optional":true},"headers":{"type":"object","additional":{"type":"string","values":["application/json","2023-06-01","https://wacrm.vercel.app","WA CRM"]},"optional":true}}}}},"legacy":{"type":"object","properties":{"account_id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"account_enabled":{"type":"boolean"},"policy_version":{"type":"string","values":["responder_v1"]},"google_search_requested":{"type":"boolean","optional":true},"ssrf_allowed_hosts":{"type":"array","items":{"type":"string"},"optional":true},"ddm":{"type":"object","properties":{"lookup_timeout_ms":{"type":"number","integer":true,"min":1,"optional":true},"discount":{"type":"number","min":0,"optional":true},"old_debt_year":{"type":"number","integer":true,"min":1,"optional":true},"current_campaign":{"type":"string","optional":true},"old_campaign":{"type":"string","optional":true},"max_installments":{"type":"number","integer":true,"min":1,"optional":true},"min_installment":{"type":"number","min":0,"optional":true},"old_max_installments":{"type":"number","integer":true,"min":1,"optional":true},"old_min_installment":{"type":"number","min":0,"optional":true},"parser_max_installments":{"type":"number","integer":true,"min":1,"optional":true},"parser_default_installments":{"type":"number","integer":true,"min":1,"optional":true},"agreement_type":{"type":"number","integer":true,"min":1,"optional":true},"wait_before_agreement_ms":{"type":"number","min":0,"optional":true},"wait_after_agreement_ms":{"type":"number","min":0,"optional":true},"timezone_policy":{"type":"string","optional":true},"locale":{"type":"string","optional":true},"lookup_endpoint":{"type":"string","values":["https://www.ddmacordos.com/calc/localiza_dev.php"],"optional":true},"calculate_endpoint":{"type":"string","values":["https://ddmacordos.com/calc/"],"optional":true},"agreement_endpoint":{"type":"string","values":["https://www.ddmacordos.com/ws_ddm/ws/CalculaDebitos.php"],"optional":true},"payment_endpoint":{"type":"string","values":["https://ddmpay.ddmacordos.com/acesso/"],"optional":true}}},"immutable_limits":{"type":"object","properties":{"tool_log_chars":{"type":"number","integer":true,"min":1,"optional":true},"last_reply_chars":{"type":"number","integer":true,"min":1,"optional":true},"http_log_chars":{"type":"number","integer":true,"min":1,"optional":true},"variable_log_chars":{"type":"number","integer":true,"min":1,"optional":true},"max_hops":{"type":"number","integer":true,"min":1,"optional":true}}}}}}}'::jsonb;
$schema$;
-- <<< descritor 215

-- Registro (202): tolera banco sem a 202 ainda; idempotente.
DO $$ BEGIN
  IF to_regclass('wacrm.schema_migrations') IS NOT NULL THEN
    INSERT INTO wacrm.schema_migrations (version) VALUES ('215_knowledge_vector') ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;
NOTIFY pgrst, 'reload schema';
