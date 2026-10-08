-- 177_ai_agent_profiles.sql — núcleo de perfis (sem ligar no engine).
-- PRÉ-CHECK manual: SELECT to_regclass('wacrm.accounts'), to_regclass('wacrm.ai_tools');
-- A conta deve existir; ai_tools (176) é opcional nesta etapa. Não aplicar backfill aqui.
-- Aplicar manualmente antes da futura API de perfis. Esta entrega não consulta estas tabelas.
BEGIN;
DO $$
BEGIN
  IF to_regclass('wacrm.accounts') IS NULL THEN RAISE EXCEPTION '177: wacrm.accounts não existe'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'wacrm.accounts'::regclass
      AND attname = 'id' AND atttypid = 'uuid'::regtype AND NOT attisdropped) THEN
    RAISE EXCEPTION '177: accounts.id deve ser uuid';
  END IF;
END $$;

-- Descritor fechado de schema.ts, conferido por agents/migration.sql.test.ts.
-- Só funções INVOKER, sem extensão jsonschema nem SECURITY DEFINER.
CREATE OR REPLACE FUNCTION wacrm.ai_agent_schema_v1() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $schema$
  SELECT '{"type":"object","properties":{"schema_version":{"type":"number","values":[1]},"llm":{"type":"object","properties":{"provider":{"type":"string","values":["openai","gemini","claude","hermes"],"optional":true},"model":{"type":"string","optional":true},"temperature":{"type":"number","min":0,"max":2,"optional":true},"max_tokens":{"type":"number","integer":true,"min":1,"optional":true},"max_completion_tokens":{"type":"number","integer":true,"min":1,"optional":true},"max_output_tokens":{"type":"number","integer":true,"min":1,"optional":true},"reasoning_effort":{"type":"string","values":["none","minimal","low","medium","high","xhigh"],"optional":true},"top_p":{"type":"number","min":0,"max":1,"optional":true},"top_k":{"type":"number","integer":true,"min":1,"optional":true},"frequency_penalty":{"type":"number","min":-2,"max":2,"optional":true},"presence_penalty":{"type":"number","min":-2,"max":2,"optional":true},"seed":{"type":"number","integer":true,"optional":true},"stop":{"type":"array","items":{"type":"string"},"optional":true},"n":{"type":"number","integer":true,"min":1,"optional":true},"tool_choice":{"type":"string","values":["auto","none","required"],"optional":true},"parallel_tool_calls":{"type":"boolean","optional":true},"stream":{"type":"boolean","optional":true},"logprobs":{"type":"boolean","optional":true},"top_logprobs":{"type":"number","min":0,"optional":true},"response_format":{"type":"string","values":["text","json_object","json_schema"],"optional":true},"response_schema":{"type":"string","optional":true},"response_mime_type":{"type":"string","optional":true},"thinking_budget":{"type":"number","min":0,"optional":true},"safety_settings":{"type":"array","items":{"type":"string"},"optional":true},"search_enabled":{"type":"boolean","optional":true},"provider_routing":{"type":"array","items":{"type":"string"},"optional":true},"logit_bias":{"type":"object","additional":{"type":"number","min":-100,"max":100},"optional":true}}},"prompt":{"type":"object","properties":{"source":{"type":"string","values":["node","account","default"]},"account_content":{"type":"string"},"legacy_override_present":{"type":"boolean"}}},"behavior":{"type":"object","properties":{"mode":{"type":"string","values":["once","loop","takeover"]},"max_turns":{"type":"number","integer":true,"min":1,"optional":true},"herdar_contexto":{"type":"boolean","optional":true},"debounce_ms":{"type":"number","min":0,"optional":true},"standalone_debounce_threshold_ms":{"type":"number","min":0,"optional":true},"free_turns":{"type":"number","min":0,"optional":true},"free_media_types":{"type":"array","items":{"type":"string"},"optional":true},"ack_words":{"type":"array","items":{"type":"string"},"optional":true},"chain_policy":{"type":"string","optional":true},"exit_tags":{"type":"array","items":{"type":"string"},"optional":true},"handoff_policy":{"type":"string","optional":true},"disabled_policy":{"type":"string","values":["failure_exit_or_handoff"],"optional":true},"stall_seconds":{"type":"number","integer":true,"min":1,"optional":true},"stall_max_minutes":{"type":"number","integer":true,"min":1,"optional":true},"legacy_ben_auto_exit":{"type":"boolean","optional":true},"legacy_flow_controlled":{"type":"boolean","optional":true}}},"recovery":{"type":"object","properties":{"attempt_retries":{"type":"number","min":0,"optional":true},"attempt_delay_ms":{"type":"number","min":0,"optional":true},"empty_reply_retries":{"type":"number","min":0,"optional":true},"empty_reply_delay_ms":{"type":"number","min":0,"optional":true},"empty_reply_text":{"type":"string","optional":true},"integration_failure_text":{"type":"string","optional":true},"integration_failure_tag":{"type":"string","optional":true},"tool_max_attempts":{"type":"number","integer":true,"min":1,"optional":true},"tool_retry_names":{"type":"array","items":{"type":"string"},"optional":true},"tool_retry_methods":{"type":"array","items":{"type":"string"},"optional":true},"tool_backoff_ms":{"type":"number","min":0,"optional":true},"tool_backoff_cap_ms":{"type":"number","min":0,"optional":true},"retry_before_external_effect_only":{"type":"boolean","optional":true}}},"protections":{"type":"object","properties":{"anti_xingamento":{"type":"object","properties":{"enabled":{"type":"boolean"},"patterns":{"type":"array","items":{"type":"string"},"optional":true},"reply":{"type":"string","optional":true},"tag":{"type":"string","optional":true},"action":{"type":"string","optional":true}}},"anti_loop":{"type":"object","properties":{"enabled":{"type":"boolean"},"min_messages":{"type":"number","integer":true,"min":1,"optional":true},"window_seconds":{"type":"number","integer":true,"min":1,"optional":true},"future_tolerance_ms":{"type":"number","min":0,"optional":true},"action":{"type":"string","optional":true}}},"pedido_humano_contestacao":{"type":"object","properties":{"enabled":{"type":"boolean"},"patterns":{"type":"array","items":{"type":"string"},"optional":true},"reply":{"type":"string","optional":true},"tag":{"type":"string","optional":true},"action":{"type":"string","optional":true}}},"pessoa_errada":{"type":"object","properties":{"enabled":{"type":"boolean"},"patterns":{"type":"array","items":{"type":"string"},"optional":true},"reply":{"type":"string","optional":true},"tag":{"type":"string","optional":true},"action":{"type":"string","optional":true}}}}},"knowledge":{"type":"object","properties":{"selection_mode":{"type":"string","values":["legacy_account_all","explicit"]},"kb_enabled":{"type":"boolean","optional":true},"file_ids":{"type":"array","items":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"optional":true},"files":{"type":"array","optional":true,"items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$","optional":true},"name":{"type":"string"},"content_hash":{"type":"string","pattern":"^[a-f0-9]{64}$"}}}},"max_chars":{"type":"number","integer":true,"min":1,"optional":true},"query_customer_messages":{"type":"number","integer":true,"min":1,"optional":true},"ranking":{"type":"string","optional":true},"name_weight":{"type":"number","min":0,"optional":true},"body_weight":{"type":"number","min":0,"optional":true},"min_term_chars":{"type":"number","integer":true,"min":1,"optional":true},"stopwords":{"type":"array","items":{"type":"string"},"optional":true},"min_partial_chars":{"type":"number","min":0,"optional":true},"truncation_note":{"type":"string","optional":true},"rag_external":{"type":"object","properties":{"enabled":{"type":"boolean"},"url":{"type":"string","pattern":"^https://[^\\s]+$","optional":true},"credential":{"type":"string","pattern":"^\\{\\{cred\\.[A-Z][A-Z0-9_]{1,63}\\}\\}$","optional":true},"top_k":{"type":"number","integer":true,"min":1,"max":50,"optional":true},"timeout_ms":{"type":"number","integer":true,"min":1,"optional":true},"max_bytes":{"type":"number","integer":true,"min":1,"optional":true},"max_context_chars":{"type":"number","integer":true,"min":1,"optional":true},"max_redirects":{"type":"number","min":0,"optional":true},"retries":{"type":"number","min":0,"optional":true},"failure_policy":{"type":"string","values":["continue_without_rag"],"optional":true}}}}},"tools":{"type":"array","items":{"type":"object","properties":{"tool_id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$","optional":true},"enabled":{"type":"boolean"},"definition":{"type":"object","properties":{"name":{"type":"string"},"description":{"type":"string"},"parameters":{"type":"object","properties":{"type":{"type":"string","values":["object"]},"properties":{"type":"object","additional":{"type":"object","properties":{"type":{"type":"string"},"description":{"type":"string"},"enum":{"type":"array","items":{"type":"string"},"optional":true}}}},"required":{"type":"array","items":{"type":"string"},"optional":true}}},"http":{"type":"object","properties":{"url":{"type":"string"},"method":{"type":"string","values":["GET","POST","PUT","PATCH","DELETE"]},"headers":{"type":"object","additional":{"type":"string"},"optional":true},"body":{"type":"string","optional":true}}},"timeout_ms":{"type":"number","integer":true,"min":1000,"max":60000,"optional":true}},"optional":true}}}},"rules":{"type":"array","items":{"type":"object","properties":{"rule_version_id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"position":{"type":"number","integer":true,"min":0},"enabled":{"type":"boolean"},"content_hash":{"type":"string","pattern":"^[a-f0-9]{64}$"}}}},"media":{"type":"object","properties":{"multimodal_enabled":{"type":"boolean","optional":true},"image_policy":{"type":"string","optional":true},"placeholders_version":{"type":"string","optional":true},"stt":{"type":"object","optional":true,"properties":{"model":{"type":"string","optional":true},"language":{"type":"string","optional":true},"mime_type":{"type":"string","optional":true},"filename":{"type":"string","optional":true},"timeout_ms":{"type":"number","integer":true,"min":1,"optional":true}}},"voice":{"type":"object","optional":true,"properties":{"enabled":{"type":"boolean","optional":true},"voice_id":{"type":"string","optional":true},"model_id":{"type":"string","optional":true},"requested_model_id":{"type":"string","optional":true},"stability":{"type":"number","min":0,"max":1,"optional":true},"similarity_boost":{"type":"number","min":0,"max":1,"optional":true},"response_mode":{"type":"string","optional":true},"mime_type":{"type":"string","optional":true},"filename_extension":{"type":"string","optional":true},"timeout_ms":{"type":"number","integer":true,"min":1,"optional":true},"storage_bucket":{"type":"string","optional":true},"cache_control_seconds":{"type":"number","min":0,"optional":true},"failure_policy":{"type":"string","optional":true}}}}},"execution":{"type":"object","properties":{"llm_timeout_ms":{"type":"number","integer":true,"min":1,"optional":true},"tool_timeout_ms":{"type":"number","integer":true,"min":1,"optional":true},"tool_max_bytes":{"type":"number","integer":true,"min":1,"optional":true},"tool_max_redirects":{"type":"number","min":0,"optional":true},"max_tool_rounds":{"type":"number","integer":true,"min":1,"optional":true},"history_limit":{"type":"number","integer":true,"min":1,"optional":true},"history_scope":{"type":"string","optional":true},"inherit_result_chars":{"type":"number","integer":true,"min":1,"optional":true},"concurrency":{"type":"number","integer":true,"min":1,"optional":true},"queue_wait_ms":{"type":"number","integer":true,"min":1,"optional":true},"rate_limit_retries":{"type":"number","min":0,"optional":true},"rate_limit_max_wait_ms":{"type":"number","integer":true,"min":1,"optional":true},"rate_limit_base_ms":{"type":"number","min":0,"optional":true},"rate_limit_jitter_ms":{"type":"number","min":0,"optional":true},"queue_heartbeat_ms":{"type":"number","integer":true,"min":1,"optional":true},"heartbeat_fresh_ms":{"type":"number","integer":true,"min":1,"optional":true},"heartbeat_write_interval_ms":{"type":"number","integer":true,"min":1,"optional":true},"watchdog_batch":{"type":"number","integer":true,"min":1,"optional":true},"safe_fetch_timeout_ms":{"type":"number","integer":true,"min":1,"optional":true},"safe_fetch_max_bytes":{"type":"number","integer":true,"min":1,"optional":true},"safe_fetch_max_redirects":{"type":"number","min":0,"optional":true},"idempotency_policy":{"type":"string","optional":true},"ownership_policy":{"type":"string","optional":true},"tools_order_policy":{"type":"string","optional":true}}},"analysis":{"type":"object","optional":true,"properties":{"history_limit":{"type":"number","integer":true,"min":1,"optional":true},"timeout_ms":{"type":"number","integer":true,"min":1,"optional":true},"max_tokens":{"type":"number","integer":true,"min":1,"optional":true},"temperature":{"type":"number","min":0,"optional":true},"response_format":{"type":"string","optional":true},"reasoning_effort":{"type":"string","optional":true}}},"connections":{"type":"object","properties":{"llm":{"type":"object","optional":true,"properties":{"credential":{"type":"string","pattern":"^\\{\\{cred\\.[A-Z][A-Z0-9_]{1,63}\\}\\}$","optional":true},"platform_env":{"type":"array","items":{"type":"string","values":["OPENAI_API_KEY","GEMINI_API_KEY","OPENROUTER_API_KEY","CLAUDE_API_KEY","ANTHROPIC_API_KEY","DDM_ACORDOS_API_TOKEN","DDM_TOKEN","DDM_API_KEY"]},"optional":true},"endpoint":{"type":"string","values":["https://api.openai.com/v1/chat/completions","https://generativelanguage.googleapis.com/v1beta/models/:model:generateContent","https://api.anthropic.com/v1/messages","https://openrouter.ai/api/v1/chat/completions","https://api.openai.com/v1/audio/transcriptions","https://api.elevenlabs.io/v1/text-to-speech/:voice_id","https://ddmacordos.com"],"optional":true},"headers":{"type":"object","additional":{"type":"string","values":["application/json","2023-06-01","https://wacrm.vercel.app","WA CRM"]},"optional":true}}},"stt":{"type":"object","optional":true,"properties":{"credential":{"type":"string","pattern":"^\\{\\{cred\\.[A-Z][A-Z0-9_]{1,63}\\}\\}$","optional":true},"platform_env":{"type":"array","items":{"type":"string","values":["OPENAI_API_KEY","GEMINI_API_KEY","OPENROUTER_API_KEY","CLAUDE_API_KEY","ANTHROPIC_API_KEY","DDM_ACORDOS_API_TOKEN","DDM_TOKEN","DDM_API_KEY"]},"optional":true},"endpoint":{"type":"string","values":["https://api.openai.com/v1/chat/completions","https://generativelanguage.googleapis.com/v1beta/models/:model:generateContent","https://api.anthropic.com/v1/messages","https://openrouter.ai/api/v1/chat/completions","https://api.openai.com/v1/audio/transcriptions","https://api.elevenlabs.io/v1/text-to-speech/:voice_id","https://ddmacordos.com"],"optional":true},"headers":{"type":"object","additional":{"type":"string","values":["application/json","2023-06-01","https://wacrm.vercel.app","WA CRM"]},"optional":true}}},"tts":{"type":"object","optional":true,"properties":{"credential":{"type":"string","pattern":"^\\{\\{cred\\.[A-Z][A-Z0-9_]{1,63}\\}\\}$","optional":true},"platform_env":{"type":"array","items":{"type":"string","values":["OPENAI_API_KEY","GEMINI_API_KEY","OPENROUTER_API_KEY","CLAUDE_API_KEY","ANTHROPIC_API_KEY","DDM_ACORDOS_API_TOKEN","DDM_TOKEN","DDM_API_KEY"]},"optional":true},"endpoint":{"type":"string","values":["https://api.openai.com/v1/chat/completions","https://generativelanguage.googleapis.com/v1beta/models/:model:generateContent","https://api.anthropic.com/v1/messages","https://openrouter.ai/api/v1/chat/completions","https://api.openai.com/v1/audio/transcriptions","https://api.elevenlabs.io/v1/text-to-speech/:voice_id","https://ddmacordos.com"],"optional":true},"headers":{"type":"object","additional":{"type":"string","values":["application/json","2023-06-01","https://wacrm.vercel.app","WA CRM"]},"optional":true}}},"ddm":{"type":"object","optional":true,"properties":{"credential":{"type":"string","pattern":"^\\{\\{cred\\.[A-Z][A-Z0-9_]{1,63}\\}\\}$","optional":true},"platform_env":{"type":"array","items":{"type":"string","values":["OPENAI_API_KEY","GEMINI_API_KEY","OPENROUTER_API_KEY","CLAUDE_API_KEY","ANTHROPIC_API_KEY","DDM_ACORDOS_API_TOKEN","DDM_TOKEN","DDM_API_KEY"]},"optional":true},"endpoint":{"type":"string","values":["https://api.openai.com/v1/chat/completions","https://generativelanguage.googleapis.com/v1beta/models/:model:generateContent","https://api.anthropic.com/v1/messages","https://openrouter.ai/api/v1/chat/completions","https://api.openai.com/v1/audio/transcriptions","https://api.elevenlabs.io/v1/text-to-speech/:voice_id","https://ddmacordos.com"],"optional":true},"headers":{"type":"object","additional":{"type":"string","values":["application/json","2023-06-01","https://wacrm.vercel.app","WA CRM"]},"optional":true}}}}},"legacy":{"type":"object","properties":{"account_id":{"type":"string","pattern":"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"},"account_enabled":{"type":"boolean"},"policy_version":{"type":"string","values":["responder_v1"]},"google_search_requested":{"type":"boolean","optional":true},"ssrf_allowed_hosts":{"type":"array","items":{"type":"string"},"optional":true},"ddm":{"type":"object","properties":{"lookup_timeout_ms":{"type":"number","integer":true,"min":1,"optional":true},"discount":{"type":"number","min":0,"optional":true},"old_debt_year":{"type":"number","integer":true,"min":1,"optional":true},"current_campaign":{"type":"string","optional":true},"old_campaign":{"type":"string","optional":true},"max_installments":{"type":"number","integer":true,"min":1,"optional":true},"min_installment":{"type":"number","min":0,"optional":true},"old_max_installments":{"type":"number","integer":true,"min":1,"optional":true},"old_min_installment":{"type":"number","min":0,"optional":true},"parser_max_installments":{"type":"number","integer":true,"min":1,"optional":true},"parser_default_installments":{"type":"number","integer":true,"min":1,"optional":true},"agreement_type":{"type":"number","integer":true,"min":1,"optional":true},"wait_before_agreement_ms":{"type":"number","min":0,"optional":true},"wait_after_agreement_ms":{"type":"number","min":0,"optional":true},"timezone_policy":{"type":"string","optional":true},"locale":{"type":"string","optional":true},"lookup_endpoint":{"type":"string","values":["https://www.ddmacordos.com/calc/localiza_dev.php"],"optional":true},"calculate_endpoint":{"type":"string","values":["https://ddmacordos.com/calc/"],"optional":true},"agreement_endpoint":{"type":"string","values":["https://www.ddmacordos.com/ws_ddm/ws/CalculaDebitos.php"],"optional":true},"payment_endpoint":{"type":"string","values":["https://ddmpay.ddmacordos.com/acesso/"],"optional":true}}},"immutable_limits":{"type":"object","properties":{"tool_log_chars":{"type":"number","integer":true,"min":1,"optional":true},"last_reply_chars":{"type":"number","integer":true,"min":1,"optional":true},"http_log_chars":{"type":"number","integer":true,"min":1,"optional":true},"variable_log_chars":{"type":"number","integer":true,"min":1,"optional":true},"max_hops":{"type":"number","integer":true,"min":1,"optional":true}}}}}}}'::jsonb;
$schema$;

CREATE OR REPLACE FUNCTION wacrm.ai_agent_json_matches(v jsonb, s jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE k text; child jsonb; item jsonb; n numeric;
BEGIN
  IF v IS NULL OR jsonb_typeof(v) IS DISTINCT FROM s->>'type' THEN RETURN false; END IF;
  IF s->>'type' = 'object' THEN
    FOR k, child IN SELECT * FROM jsonb_each(coalesce(s->'properties', '{}'::jsonb)) LOOP
      IF NOT (v ? k) THEN
        IF coalesce((child->>'optional')::boolean, false) THEN CONTINUE; END IF;
        RETURN false;
      END IF;
      IF NOT wacrm.ai_agent_json_matches(v->k, child) THEN RETURN false; END IF;
    END LOOP;
    FOR k IN SELECT jsonb_object_keys(v) LOOP
      IF coalesce(s->'properties', '{}'::jsonb) ? k THEN CONTINUE; END IF;
      IF NOT (s ? 'additional') OR NOT wacrm.ai_agent_json_matches(v->k, s->'additional') THEN RETURN false; END IF;
    END LOOP;
  ELSIF s->>'type' = 'array' THEN
    FOR item IN SELECT * FROM jsonb_array_elements(v) LOOP
      IF NOT wacrm.ai_agent_json_matches(item, s->'items') THEN RETURN false; END IF;
    END LOOP;
  ELSIF s->>'type' = 'number' THEN
    n := (v #>> '{}')::numeric;
    IF coalesce((s->>'integer')::boolean, false) AND n <> trunc(n) THEN RETURN false; END IF;
    IF (s ? 'min' AND n < (s->>'min')::numeric) OR (s ? 'max' AND n > (s->>'max')::numeric) THEN RETURN false; END IF;
  ELSIF s->>'type' = 'string' THEN
    IF s ? 'pattern' AND NOT ((v #>> '{}') ~ (s->>'pattern')) THEN RETURN false; END IF;
  END IF;
  IF s ? 'values' AND NOT (s->'values' @> jsonb_build_array(v)) THEN RETURN false; END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION wacrm.ai_agent_config_v1_valid(v jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE rag jsonb; tool jsonb; url text;
BEGIN
  IF NOT wacrm.ai_agent_json_matches(v, wacrm.ai_agent_schema_v1()) THEN RETURN false; END IF;
  rag := v #> '{knowledge,rag_external}';
  IF (rag->>'enabled')::boolean AND NOT (rag ?& ARRAY['url', 'credential', 'top_k', 'timeout_ms']) THEN RETURN false; END IF;
  IF rag ? 'url' THEN
    url := rag->>'url';
    IF position('#' IN url) > 0 OR split_part(substring(url FROM 9), '/', 1) ~ '@' THEN RETURN false; END IF;
  END IF;
  FOR tool IN SELECT * FROM jsonb_array_elements(v->'tools') LOOP
    IF NOT (tool ? 'tool_id' OR tool ? 'definition') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE TABLE IF NOT EXISTS wacrm.ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT true,
  published_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id), UNIQUE (account_id, name)
);
CREATE TABLE IF NOT EXISTS wacrm.ai_agent_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  config jsonb NOT NULL CHECK (wacrm.ai_agent_config_v1_valid(config)),
  prompt_content text NOT NULL,
  composition text NOT NULL CHECK (composition IN ('legacy_v1', 'sections_v1')),
  config_hash text NOT NULL CHECK (config_hash ~ '^[a-f0-9]{64}$'),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Só metadata monotônica de selagem: conteúdo nunca pode ser atualizado.
  published_at timestamptz,
  UNIQUE (account_id, id), UNIQUE (account_id, agent_id, id), UNIQUE (account_id, agent_id, version),
  FOREIGN KEY (account_id, agent_id) REFERENCES wacrm.ai_agents(account_id, id) ON DELETE CASCADE,
  CHECK (config #>> '{legacy,account_id}' = account_id::text)
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'wacrm.ai_agents'::regclass AND conname = 'ai_agents_published_version_fk') THEN
    ALTER TABLE wacrm.ai_agents ADD CONSTRAINT ai_agents_published_version_fk
      FOREIGN KEY (account_id, id, published_version_id) REFERENCES wacrm.ai_agent_versions(account_id, agent_id, id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS ai_agent_versions_hash_idx ON wacrm.ai_agent_versions(account_id, config_hash);
CREATE INDEX IF NOT EXISTS ai_agents_published_idx ON wacrm.ai_agents(account_id, id, published_version_id);

CREATE TABLE IF NOT EXISTS wacrm.ai_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES wacrm.accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id), UNIQUE (account_id, name)
);
CREATE TABLE IF NOT EXISTS wacrm.ai_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL, rule_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0), content text NOT NULL,
  created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id), UNIQUE (account_id, rule_id, version),
  FOREIGN KEY (account_id, rule_id) REFERENCES wacrm.ai_rules(account_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS wacrm.ai_agent_rules (
  account_id uuid NOT NULL, agent_version_id uuid NOT NULL, rule_version_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0), enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (account_id, agent_version_id, position), UNIQUE (account_id, agent_version_id, rule_version_id),
  FOREIGN KEY (account_id, agent_version_id) REFERENCES wacrm.ai_agent_versions(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, rule_version_id) REFERENCES wacrm.ai_rule_versions(account_id, id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS ai_agent_rules_rule_idx ON wacrm.ai_agent_rules(account_id, rule_version_id);
CREATE TABLE IF NOT EXISTS wacrm.ai_agent_tools (
  account_id uuid NOT NULL, agent_version_id uuid NOT NULL, tool_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0), enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (account_id, agent_version_id, position), UNIQUE (account_id, agent_version_id, tool_id),
  FOREIGN KEY (account_id, agent_version_id) REFERENCES wacrm.ai_agent_versions(account_id, id) ON DELETE CASCADE
);
-- TODO-176: após integrar ai_tools, acrescentar FK (account_id, tool_id) para
-- ai_tools(account_id, id). Até lá, o serviço deve validar tenancy das referências.
CREATE INDEX IF NOT EXISTS ai_agent_tools_tool_idx ON wacrm.ai_agent_tools(account_id, tool_id);
CREATE TABLE IF NOT EXISTS wacrm.ai_agent_knowledge (
  account_id uuid NOT NULL, agent_version_id uuid NOT NULL,
  selection_mode text NOT NULL CHECK (selection_mode IN ('legacy_account_all', 'explicit')),
  file_ids uuid[],
  PRIMARY KEY (account_id, agent_version_id),
  FOREIGN KEY (account_id, agent_version_id) REFERENCES wacrm.ai_agent_versions(account_id, id) ON DELETE CASCADE,
  CHECK ((selection_mode = 'legacy_account_all' AND coalesce(cardinality(file_ids), 0) = 0)
    OR (selection_mode = 'explicit' AND file_ids IS NOT NULL))
);
-- knowledge_base_files foi criada fora das migrations: tenancy de file_ids deve
-- ser validada no serviço; FK/versões dos arquivos ficam para a integração de KB.

CREATE OR REPLACE FUNCTION wacrm.ai_agent_version_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - 'published_at') IS DISTINCT FROM (to_jsonb(OLD) - 'published_at')
       OR OLD.published_at IS NOT NULL OR NEW.published_at IS NULL THEN
      RAISE EXCEPTION 'Versão de agente imutável: crie uma nova versão';
    END IF;
    RETURN NEW;
  END IF;
  -- Permitir somente o cascade quando o catálogo/conta pai já foi removido.
  IF EXISTS (SELECT 1 FROM wacrm.ai_agents WHERE account_id = OLD.account_id AND id = OLD.agent_id) THEN
    RAISE EXCEPTION 'Versão de agente imutável';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS ai_agent_version_immutable ON wacrm.ai_agent_versions;
CREATE TRIGGER ai_agent_version_immutable BEFORE UPDATE OR DELETE ON wacrm.ai_agent_versions
  FOR EACH ROW EXECUTE FUNCTION wacrm.ai_agent_version_immutable();

CREATE OR REPLACE FUNCTION wacrm.ai_rule_version_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR EXISTS (SELECT 1 FROM wacrm.ai_rules WHERE account_id = OLD.account_id AND id = OLD.rule_id) THEN
    RAISE EXCEPTION 'Versão de regra imutável';
  END IF;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS ai_rule_version_immutable ON wacrm.ai_rule_versions;
CREATE TRIGGER ai_rule_version_immutable BEFORE UPDATE OR DELETE ON wacrm.ai_rule_versions
  FOR EACH ROW EXECUTE FUNCTION wacrm.ai_rule_version_immutable();

CREATE OR REPLACE FUNCTION wacrm.ai_agent_binding_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE old_published timestamptz; new_published timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    SELECT published_at INTO old_published FROM wacrm.ai_agent_versions
      WHERE account_id = OLD.account_id AND id = OLD.agent_version_id FOR UPDATE;
    IF old_published IS NOT NULL THEN RAISE EXCEPTION 'Vínculo de versão publicada é imutável'; END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    SELECT published_at INTO new_published FROM wacrm.ai_agent_versions
      WHERE account_id = NEW.account_id AND id = NEW.agent_version_id FOR UPDATE;
    IF new_published IS NOT NULL THEN RAISE EXCEPTION 'Vínculo de versão publicada é imutável'; END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;

CREATE OR REPLACE FUNCTION wacrm.ai_agent_publish_version() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE target wacrm.ai_agent_versions;
BEGIN
  IF NEW.published_version_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO target FROM wacrm.ai_agent_versions
    WHERE account_id = NEW.account_id AND agent_id = NEW.id AND id = NEW.published_version_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Versão publicada não pertence ao agente/conta'; END IF;
  IF target.composition = 'legacy_v1' AND EXISTS (
    SELECT 1 FROM wacrm.ai_agent_rules WHERE account_id = NEW.account_id AND agent_version_id = target.id AND enabled
  ) THEN RAISE EXCEPTION 'legacy_v1 mantém rules=[]'; END IF;
  IF target.published_at IS NULL THEN
    UPDATE wacrm.ai_agent_versions SET published_at = now() WHERE account_id = NEW.account_id AND id = target.id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ai_agent_publish_version ON wacrm.ai_agents;
CREATE TRIGGER ai_agent_publish_version BEFORE INSERT OR UPDATE OF published_version_id ON wacrm.ai_agents
  FOR EACH ROW EXECUTE FUNCTION wacrm.ai_agent_publish_version();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['ai_agents', 'ai_agent_versions', 'ai_rules', 'ai_rule_versions', 'ai_agent_rules', 'ai_agent_tools', 'ai_agent_knowledge'] LOOP
    EXECUTE format('ALTER TABLE wacrm.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON wacrm.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON wacrm.%I TO service_role', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['ai_agent_rules', 'ai_agent_tools', 'ai_agent_knowledge'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS ai_agent_binding_immutable ON wacrm.%I', t);
    EXECUTE format('CREATE TRIGGER ai_agent_binding_immutable BEFORE INSERT OR UPDATE OR DELETE ON wacrm.%I FOR EACH ROW EXECUTE FUNCTION wacrm.ai_agent_binding_immutable()', t);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION wacrm.ai_agent_schema_v1(), wacrm.ai_agent_json_matches(jsonb, jsonb),
  wacrm.ai_agent_config_v1_valid(jsonb), wacrm.ai_agent_version_immutable(), wacrm.ai_rule_version_immutable(),
  wacrm.ai_agent_binding_immutable(), wacrm.ai_agent_publish_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION wacrm.ai_agent_schema_v1(), wacrm.ai_agent_json_matches(jsonb, jsonb),
  wacrm.ai_agent_config_v1_valid(jsonb), wacrm.ai_agent_version_immutable(), wacrm.ai_rule_version_immutable(),
  wacrm.ai_agent_binding_immutable(), wacrm.ai_agent_publish_version() TO service_role;
COMMIT;
NOTIFY pgrst, 'reload schema';
