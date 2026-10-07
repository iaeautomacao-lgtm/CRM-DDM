// Schema fechado e defaults do núcleo. Sem resolução de secrets, rede ou defaults no parse.
// A migration 177 contém este mesmo descritor, conferido pelo teste SQL.
type Spec = {
  type: "object" | "array" | "string" | "number" | "boolean";
  optional?: boolean;
  properties?: Record<string, Spec>;
  additional?: Spec;
  items?: Spec;
  values?: readonly (string | number)[];
  pattern?: string;
  min?: number;
  max?: number;
  integer?: boolean;
};

type Infer<S extends Spec> = S["type"] extends "object"
  ? S extends { properties: infer P extends Record<string, Spec> }
    ? { -readonly [K in keyof P as P[K] extends { optional: true } ? never : K]: Infer<P[K]> }
      & { -readonly [K in keyof P as P[K] extends { optional: true } ? K : never]?: Infer<P[K]> }
    : S extends { additional: infer A extends Spec } ? Record<string, Infer<A>> : Record<string, never>
  : S["type"] extends "array" ? S extends { items: infer I extends Spec } ? Infer<I>[] : never
  : S extends { values: readonly (infer V)[] } ? V
  : S["type"] extends "string" ? string
  : S["type"] extends "boolean" ? boolean : number;

const bool = { type: "boolean", optional: true } as const;
const text = { type: "string", optional: true } as const;
const positive = { type: "number", integer: true, min: 1, optional: true } as const;
const nonnegative = { type: "number", min: 0, optional: true } as const;
const texts = { type: "array", items: { type: "string" }, optional: true } as const;
const uuid = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" } as const;
const credential = { type: "string", pattern: "^\\{\\{cred\\.[A-Z][A-Z0-9_]{1,63}\\}\\}$", optional: true } as const;
const connection = { type: "object", optional: true, properties: {
  credential, platform_env: texts, endpoint: text, headers: { type: "object", additional: { type: "string" }, optional: true },
} } as const;
const protection = { type: "object", properties: {
  enabled: { type: "boolean" }, patterns: texts, reply: text, tag: text, action: text,
} } as const;
const toolDefinition = { type: "object", properties: {
  name: { type: "string" }, description: { type: "string" },
  parameters: { type: "object", properties: {
    type: { type: "string", values: ["object"] },
    properties: { type: "object", additional: { type: "object", properties: {
      type: { type: "string" }, description: { type: "string" }, enum: texts,
    } } }, required: texts,
  } },
  http: { type: "object", properties: {
    url: { type: "string" }, method: { type: "string", values: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
    headers: { type: "object", additional: { type: "string" }, optional: true }, body: text,
  } },
  timeout_ms: { type: "number", integer: true, min: 1000, max: 60000, optional: true },
} } as const;

export const AGENT_CONFIG_SPEC = { type: "object", properties: {
  schema_version: { type: "number", values: [1] },
  llm: { type: "object", properties: {
    provider: { type: "string", values: ["openai", "gemini", "claude", "hermes"], optional: true }, model: text,
    temperature: { type: "number", min: 0, max: 2, optional: true },
    max_tokens: positive, max_completion_tokens: positive, max_output_tokens: positive,
    reasoning_effort: { type: "string", values: ["none", "minimal", "low", "medium", "high", "xhigh"], optional: true },
    top_p: { type: "number", min: 0, max: 1, optional: true }, top_k: positive,
    frequency_penalty: { type: "number", min: -2, max: 2, optional: true },
    presence_penalty: { type: "number", min: -2, max: 2, optional: true }, seed: { type: "number", integer: true, optional: true },
    stop: texts, n: positive, tool_choice: { type: "string", values: ["auto", "none", "required"], optional: true },
    parallel_tool_calls: bool, stream: bool, logprobs: bool, top_logprobs: nonnegative,
    response_format: { type: "string", values: ["text", "json_object", "json_schema"], optional: true },
    response_schema: { type: "string", optional: true }, response_mime_type: text,
    thinking_budget: nonnegative, safety_settings: texts, search_enabled: bool, provider_routing: texts,
    logit_bias: { type: "object", additional: { type: "number", min: -100, max: 100 }, optional: true },
  } },
  prompt: { type: "object", properties: {
    source: { type: "string", values: ["node", "account", "default"] },
    account_content: { type: "string" },
    // Não materializar fallback como override: isso desliga caminhos legados.
    legacy_override_present: { type: "boolean" },
  } },
  behavior: { type: "object", properties: {
    mode: { type: "string", values: ["once", "loop", "takeover"] },
    max_turns: positive, herdar_contexto: bool, debounce_ms: nonnegative, standalone_debounce_threshold_ms: nonnegative,
    free_turns: nonnegative, free_media_types: texts, ack_words: texts, chain_policy: text,
    exit_tags: texts, handoff_policy: text, disabled_policy: { type: "string", values: ["failure_exit_or_handoff"], optional: true },
    stall_seconds: positive, stall_max_minutes: positive, legacy_ben_auto_exit: bool, legacy_flow_controlled: bool,
  } },
  recovery: { type: "object", properties: {
    attempt_retries: nonnegative, attempt_delay_ms: nonnegative, empty_reply_retries: nonnegative,
    empty_reply_delay_ms: nonnegative, empty_reply_text: text, integration_failure_text: text, integration_failure_tag: text,
    tool_max_attempts: positive, tool_retry_names: texts, tool_retry_methods: texts,
    tool_backoff_ms: nonnegative, tool_backoff_cap_ms: nonnegative, retry_before_external_effect_only: bool,
  } },
  protections: { type: "object", properties: {
    anti_xingamento: protection,
    anti_loop: { type: "object", properties: {
      enabled: { type: "boolean" }, min_messages: positive, window_seconds: positive, future_tolerance_ms: nonnegative, action: text,
    } },
    pedido_humano_contestacao: protection, pessoa_errada: protection,
    // Opt-out não é uma opção do perfil. Barreiras técnicas também não têm toggle.
  } },
  knowledge: { type: "object", properties: {
    selection_mode: { type: "string", values: ["legacy_account_all", "explicit"] }, kb_enabled: bool,
    file_ids: { type: "array", items: uuid, optional: true },
    files: { type: "array", optional: true, items: { type: "object", properties: {
      id: { ...uuid, optional: true }, name: { type: "string" }, content_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    } } },
    max_chars: positive, query_customer_messages: positive, ranking: text, name_weight: nonnegative, body_weight: nonnegative,
    min_term_chars: positive, stopwords: texts, min_partial_chars: nonnegative, truncation_note: text,
    rag_external: { type: "object", properties: {
      enabled: { type: "boolean" }, url: { type: "string", pattern: "^https://[^\\s]+$", optional: true }, credential,
      top_k: { type: "number", integer: true, min: 1, max: 50, optional: true }, timeout_ms: positive,
      max_bytes: positive, max_context_chars: positive, max_redirects: nonnegative, retries: nonnegative,
      failure_policy: { type: "string", values: ["continue_without_rag"], optional: true },
    } },
  } },
  tools: { type: "array", items: { type: "object", properties: {
    tool_id: { ...uuid, optional: true }, enabled: { type: "boolean" },
    // Definição efetiva permite hash completo antes de integrar o catálogo da 176.
    definition: { ...toolDefinition, optional: true },
  } } },
  // Só referências/hash aqui; texto das regras vive em ai_rule_versions.
  rules: { type: "array", items: { type: "object", properties: {
    rule_version_id: uuid, position: { type: "number", integer: true, min: 0 }, enabled: { type: "boolean" },
    content_hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
  } } },
  media: { type: "object", properties: {
    multimodal_enabled: bool, image_policy: text, placeholders_version: text,
    stt: { type: "object", optional: true, properties: { model: text, language: text, mime_type: text, filename: text, timeout_ms: positive } },
    voice: { type: "object", optional: true, properties: {
      enabled: bool, voice_id: text, model_id: text, requested_model_id: text,
      stability: { type: "number", min: 0, max: 1, optional: true }, similarity_boost: { type: "number", min: 0, max: 1, optional: true },
      response_mode: text, mime_type: text, filename_extension: text, timeout_ms: positive,
      storage_bucket: text, cache_control_seconds: nonnegative, failure_policy: text,
    } },
  } },
  execution: { type: "object", properties: {
    llm_timeout_ms: positive, tool_timeout_ms: positive, tool_max_bytes: positive, tool_max_redirects: nonnegative, max_tool_rounds: positive,
    history_limit: positive, history_scope: text, inherit_result_chars: positive,
    concurrency: positive, queue_wait_ms: positive, rate_limit_retries: nonnegative, rate_limit_max_wait_ms: positive,
    rate_limit_base_ms: nonnegative, rate_limit_jitter_ms: nonnegative, queue_heartbeat_ms: positive,
    heartbeat_fresh_ms: positive, heartbeat_write_interval_ms: positive, watchdog_batch: positive,
    safe_fetch_timeout_ms: positive, safe_fetch_max_bytes: positive, safe_fetch_max_redirects: nonnegative,
    idempotency_policy: text, ownership_policy: text, tools_order_policy: text,
  } },
  // Subpolicy de análise da conta; não herda geração do agente conversacional.
  analysis: { type: "object", optional: true, properties: {
    history_limit: positive, timeout_ms: positive, max_tokens: positive, temperature: nonnegative,
    response_format: text, reasoning_effort: text,
  } },
  connections: { type: "object", properties: { llm: connection, stt: connection, tts: connection, ddm: connection } },
  legacy: { type: "object", properties: {
    account_id: uuid, account_enabled: { type: "boolean" }, policy_version: { type: "string", values: ["responder_v1"] },
    // Corpus legado é espelhado em compose; flags registradas não ativam capacidades ignoradas hoje.
    google_search_requested: bool, ssrf_allowed_hosts: texts,
    ddm: { type: "object", properties: {
      lookup_timeout_ms: positive, discount: nonnegative, old_debt_year: positive, current_campaign: text, old_campaign: text,
      max_installments: positive, min_installment: nonnegative, old_max_installments: positive, old_min_installment: nonnegative,
      parser_max_installments: positive, parser_default_installments: positive, agreement_type: positive,
      wait_before_agreement_ms: nonnegative, wait_after_agreement_ms: nonnegative, timezone_policy: text, locale: text,
      lookup_endpoint: text, calculate_endpoint: text, agreement_endpoint: text, payment_endpoint: text,
    } },
    immutable_limits: { type: "object", properties: {
      tool_log_chars: positive, last_reply_chars: positive, http_log_chars: positive, variable_log_chars: positive, max_hops: positive,
    } },
  } },
} } as const satisfies Spec;

export type AgentConfig = Infer<typeof AGENT_CONFIG_SPEC>;
export type AgentComposition = "legacy_v1" | "sections_v1";
export interface AgentPromptVersion { config: AgentConfig; prompt_content: string; composition: AgentComposition }
export interface AgentRule { content: string; position: number; enabled: boolean; version_id?: string }

// Única constante de defaults do núcleo; parse/validate não preenchem campos ausentes.
export const LEGACY_AGENT_DEFAULTS = {
  behavior: {
    max_turns: 20, herdar_contexto: false, debounce_ms: 4000, standalone_debounce_threshold_ms: 3800,
    free_turns: 3, free_media_types: ["image", "sticker", "video", "document"],
    ack_words: ["ok", "okay", "okk", "okok", "obrigado", "obrigada", "obg", "muito"], chain_policy: "legacy_v1",
    handoff_policy: "legacy_v1", disabled_policy: "failure_exit_or_handoff", stall_seconds: 180, stall_max_minutes: 30,
  },
  recovery: {
    attempt_retries: 1, attempt_delay_ms: 3000, empty_reply_retries: 1, empty_reply_delay_ms: 0,
    empty_reply_text: "Olá! 😊 Tudo bem? Sou o Ben, do Grupo DDM. Para verificarmos sua situação, preciso do seu CPF (apenas os números). Pode me passar?",
    integration_failure_text: "Estamos com uma instabilidade no sistema para consultar seus dados agora. Vou te encaminhar para um de nossos atendentes, que continua seu atendimento por aqui. Só um instante!",
    integration_failure_tag: "#INSTABILIDADE", tool_max_attempts: 3,
    tool_retry_names: ["localizar_devedor", "consultar_debitos"], tool_retry_methods: ["GET"],
    tool_backoff_ms: 300, tool_backoff_cap_ms: 1200, retry_before_external_effect_only: true,
  },
  protections: {
    anti_xingamento: { enabled: true, action: "team_queue" },
    anti_loop: { enabled: true, min_messages: 8, window_seconds: 120, future_tolerance_ms: 5000, action: "team_queue" },
    pedido_humano_contestacao: { enabled: true }, pessoa_errada: { enabled: true },
  },
  knowledge: {
    kb_enabled: true, max_chars: 40000, query_customer_messages: 3, ranking: "lexical_v1", name_weight: 3, body_weight: 1,
    min_term_chars: 3, stopwords: ["a", "o", "e", "de", "da", "do", "em", "um", "uma", "que", "para", "por", "com", "no", "na", "os", "as", "se", "eu", "me", "meu", "minha", "foi", "ser", "tem", "mais", "mas", "como", "voce"],
    min_partial_chars: 500, truncation_note: "\n[... trecho omitido por tamanho ...]",
    rag_external: { enabled: false, top_k: 5, timeout_ms: 5000, max_bytes: 262144, max_context_chars: 8000,
      max_redirects: 0, retries: 0, failure_policy: "continue_without_rag" },
  },
  media: {
    multimodal_enabled: false, image_policy: "legacy_provider_v1", placeholders_version: "legacy_v1",
    stt: { model: "whisper-1", language: "pt", mime_type: "audio/ogg", filename: "audio.ogg", timeout_ms: 15000 },
    voice: { enabled: false, voice_id: "33B4UnXyTNbgLmdEDh5P", model_id: "eleven_multilingual_v2",
      stability: 0.5, similarity_boost: 0.75, response_mode: "audio_if_transcribed_audio", mime_type: "audio/mpeg", filename_extension: "mp3", timeout_ms: 15000,
      storage_bucket: "chat-media", cache_control_seconds: 31536000, failure_policy: "keep_text_reply" },
  },
  execution: {
    llm_timeout_ms: 15000, tool_timeout_ms: 30000, tool_max_bytes: 1048576, tool_max_redirects: 3, max_tool_rounds: 5,
    history_limit: 10, history_scope: "run_start", inherit_result_chars: 3000,
    concurrency: 20, queue_wait_ms: 60000, rate_limit_retries: 2, rate_limit_max_wait_ms: 8000,
    rate_limit_base_ms: 1000, rate_limit_jitter_ms: 250, queue_heartbeat_ms: 10000,
    heartbeat_fresh_ms: 120000, heartbeat_write_interval_ms: 15000, watchdog_batch: 50,
    safe_fetch_timeout_ms: 15000, safe_fetch_max_bytes: 2097152, safe_fetch_max_redirects: 3,
    idempotency_policy: "account_conversation_message_node_claim_v1", ownership_policy: "run_cas_v1", tools_order_policy: "sequential_v1",
  },
  connections: {
    openai: { endpoint: "https://api.openai.com/v1/chat/completions", headers: { "Content-Type": "application/json" } },
    gemini: { endpoint: "https://generativelanguage.googleapis.com/v1beta/models/:model:generateContent", headers: { "Content-Type": "application/json" } },
    claude: { endpoint: "https://api.anthropic.com/v1/messages", headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" } },
    hermes: { endpoint: "https://openrouter.ai/api/v1/chat/completions", headers: { "Content-Type": "application/json", "HTTP-Referer": "https://wacrm.vercel.app", "X-Title": "WA CRM" } },
    stt: { endpoint: "https://api.openai.com/v1/audio/transcriptions" },
    tts: { endpoint: "https://api.elevenlabs.io/v1/text-to-speech/:voice_id" },
    ddm: { endpoint: "https://ddmacordos.com" },
  },
  analysis: { history_limit: 15, timeout_ms: 20000, max_tokens: 500, temperature: 0.2, response_format: "json_object" },
  ddm: { lookup_timeout_ms: 10000, discount: 40, old_debt_year: 2019, current_campaign: "2025.1", old_campaign: "Até 2019",
    max_installments: 6, min_installment: 150, old_max_installments: 10, old_min_installment: 100,
    parser_max_installments: 12, parser_default_installments: 1, agreement_type: 1,
    wait_before_agreement_ms: 3000, wait_after_agreement_ms: 3000, timezone_policy: "legacy_server", locale: "pt-BR",
    lookup_endpoint: "https://www.ddmacordos.com/calc/localiza_dev.php", calculate_endpoint: "https://ddmacordos.com/calc/",
    agreement_endpoint: "https://www.ddmacordos.com/ws_ddm/ws/CalculaDebitos.php", payment_endpoint: "https://ddmpay.ddmacordos.com/acesso/" },
  immutable_limits: { tool_log_chars: 8000, last_reply_chars: 300, http_log_chars: 2000, variable_log_chars: 200, max_hops: 50 },
  llm: { temperature: 0.7, max_tokens: 1000 },
  fallback_prompt: "Você é um assistente virtual. Aguarde um momento.",
} as const;

export interface AgentConfigIssue { path: string; message: string }
export type AgentConfigValidation = { success: true; data: AgentConfig } | { success: false; issues: AgentConfigIssue[] };

function inspect(value: unknown, spec: Spec, path: string, issues: AgentConfigIssue[]): void {
  const fail = (message: string) => issues.push({ path, message });
  if (value === undefined && spec.optional) return;
  if (spec.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) { fail("Objeto obrigatório."); return; }
    const obj = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(spec.properties ?? {})) inspect(obj[key], child, `${path}.${key}`, issues);
    for (const key of Object.keys(obj)) {
      if (Object.hasOwn(spec.properties ?? {}, key)) continue;
      if (spec.additional) inspect(obj[key], spec.additional, `${path}.${key}`, issues);
      else issues.push({ path: `${path}.${key}`, message: "Campo desconhecido." });
    }
    return;
  }
  if (spec.type === "array") {
    if (!Array.isArray(value)) { fail("Lista obrigatória."); return; }
    for (let i = 0; i < value.length; i++) inspect(value[i], spec.items!, `${path}[${i}]`, issues);
    return;
  }
  if (typeof value !== spec.type) { fail(`Tipo esperado: ${spec.type}.`); return; }
  if (typeof value === "number" && (!Number.isFinite(value) || (spec.integer && !Number.isInteger(value))
    || (spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max))) fail("Número fora do intervalo permitido.");
  if (spec.values && !spec.values.includes(value as string | number)) fail("Valor não permitido.");
  if (spec.pattern && !new RegExp(spec.pattern).test(value as string)) fail("Formato inválido.");
}

export function validateAgentConfig(value: unknown): AgentConfigValidation {
  const issues: AgentConfigIssue[] = [];
  inspect(value, AGENT_CONFIG_SPEC, "config", issues);
  if (issues.length) return { success: false, issues };
  const config = value as AgentConfig;
  const rag = config.knowledge.rag_external;
  if (rag.enabled && (!rag.url || !rag.credential || !rag.top_k || !rag.timeout_ms)) {
    issues.push({ path: "config.knowledge.rag_external", message: "RAG habilitado exige URL, credencial, top_k e timeout." });
  }
  if (rag.url) {
    try {
      const url = new URL(rag.url);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
    } catch { issues.push({ path: "config.knowledge.rag_external.url", message: "URL HTTPS sem segredo/fragmento na autoridade." }); }
  }
  config.tools.forEach((tool, i) => {
    if (!tool.tool_id && !tool.definition) issues.push({ path: `config.tools[${i}]`, message: "Ferramenta exige referência ou definição legada." });
  });
  // Sem defaults, trim ou coercion: omissões e bytes do prompt sobrevivem ao parse.
  return issues.length ? { success: false, issues } : { success: true, data: structuredClone(config) };
}

export function parseAgentConfig(value: unknown): AgentConfig {
  const result = validateAgentConfig(value);
  if (!result.success) throw new Error(result.issues.map((i) => `${i.path}: ${i.message}`).join("; "));
  return result.data;
}
