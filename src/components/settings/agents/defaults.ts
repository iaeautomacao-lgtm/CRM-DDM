import { LEGACY_AGENT_DEFAULTS, type AgentConfig } from '@/lib/ai/agents/schema';
import { DEFAULT_MODEL_BY_PROVIDER, type AiProvider } from '@/lib/ai/models';
import { KNOWN_AI_EXIT_TAGS } from '@/lib/ai/exit-tags';
import type {
  AgentDetailResponse,
  AgentFormData,
  PreviewAgentPayload,
  SaveAgentPayload,
} from './types';

export function createInitialAgentFormData(): AgentFormData {
  const defaults = LEGACY_AGENT_DEFAULTS;

  return {
    name: 'Novo Agente',
    enabled: true,
    prompt_content: '',
    composition: 'sections_v1',
    rules: [],
    knowledge: {
      selection_mode: 'legacy_account_all',
      file_ids: [],
      rag_external: {
        enabled: false,
        url: '',
        credential: '',
        top_k: defaults.knowledge.rag_external.top_k,
        timeout_ms: defaults.knowledge.rag_external.timeout_ms,
      },
    },
    tools: [],
    llm: {
      provider: 'openai',
      model: DEFAULT_MODEL_BY_PROVIDER.openai,
      temperatureUseDefault: true,
      temperature: defaults.llm.temperature,
      maxTokensUseDefault: true,
      max_tokens: defaults.llm.max_tokens,
      topPUseDefault: true,
      top_p: 1,
      frequencyPenaltyUseDefault: true,
      frequency_penalty: 0,
      presencePenaltyUseDefault: true,
      presence_penalty: 0,
      reasoningEffortUseDefault: true,
      reasoning_effort: 'none',
      responseFormatUseDefault: true,
      response_format: 'text',
    },
    behavior: {
      mode: 'loop',
      max_turns: defaults.behavior.max_turns,
      herdar_contexto: defaults.behavior.herdar_contexto,
      debounce_ms: defaults.behavior.debounce_ms,
      stall_seconds: defaults.behavior.stall_seconds,
    },
    recovery: {
      attempt_retries: defaults.recovery.attempt_retries,
      empty_reply_text: defaults.recovery.empty_reply_text,
      integration_failure_text: defaults.recovery.integration_failure_text,
      integration_failure_tag: defaults.recovery.integration_failure_tag,
    },
    protections: {
      anti_xingamento: defaults.protections.anti_xingamento.enabled,
      anti_loop: defaults.protections.anti_loop.enabled,
      pedido_humano_contestacao: defaults.protections.pedido_humano_contestacao.enabled,
      pessoa_errada: defaults.protections.pessoa_errada.enabled,
    },
    execution: {
      llm_timeout_ms: defaults.execution.llm_timeout_ms,
    },
  };
}

export function formDataFromPublished(
  agent: AgentDetailResponse['agent'],
  published: AgentDetailResponse['published'],
): AgentFormData {
  const initial = createInitialAgentFormData();
  if (!published) {
    return {
      ...initial,
      name: agent.name,
      enabled: agent.enabled,
    };
  }

  const { config, prompt_content, composition, rules, tools, knowledge } = published;
  const cfgLlm = config.llm ?? {};
  const cfgKnowledge = config.knowledge ?? {};
  const cfgRag = cfgKnowledge.rag_external ?? {};
  const cfgBehavior = config.behavior ?? {};
  const cfgRecovery = config.recovery ?? {};
  const cfgProtections = config.protections ?? {};
  const cfgExecution = config.execution ?? {};

  const mappedRules = Array.isArray(rules)
    ? rules
        .slice()
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((r, idx) => ({
          id: r.rule_version_id || r.id || `rule-${idx}-${Date.now()}`,
          content: r.content,
          enabled: r.enabled !== false,
        }))
    : [];

  const mappedTools = Array.isArray(tools)
    ? tools.map((t) => ({
        tool_id: t.id,
        enabled: t.enabled !== false,
      }))
    : [];

  const provider = (cfgLlm.provider as AgentFormData['llm']['provider']) || 'openai';

  return {
    name: agent.name,
    enabled: agent.enabled,
    prompt_content: prompt_content ?? '',
    composition: composition || 'sections_v1',
    rules: mappedRules,
    knowledge: {
      selection_mode: knowledge?.selection_mode || cfgKnowledge.selection_mode || 'legacy_account_all',
      file_ids: knowledge?.file_ids || cfgKnowledge.file_ids || [],
      rag_external: {
        enabled: cfgRag.enabled ?? false,
        url: cfgRag.url ?? '',
        credential: cfgRag.credential ?? '',
        top_k: cfgRag.top_k ?? initial.knowledge.rag_external.top_k,
        timeout_ms: cfgRag.timeout_ms ?? initial.knowledge.rag_external.timeout_ms,
      },
    },
    tools: mappedTools,
    llm: {
      provider,
      model: cfgLlm.model || DEFAULT_MODEL_BY_PROVIDER[provider as AiProvider],
      temperatureUseDefault: cfgLlm.temperature === undefined,
      temperature: cfgLlm.temperature ?? initial.llm.temperature,
      maxTokensUseDefault: cfgLlm.max_tokens === undefined && cfgLlm.max_output_tokens === undefined,
      max_tokens: cfgLlm.max_tokens ?? cfgLlm.max_output_tokens ?? initial.llm.max_tokens,
      topPUseDefault: cfgLlm.top_p === undefined,
      top_p: cfgLlm.top_p ?? initial.llm.top_p,
      frequencyPenaltyUseDefault: cfgLlm.frequency_penalty === undefined,
      frequency_penalty: cfgLlm.frequency_penalty ?? initial.llm.frequency_penalty,
      presencePenaltyUseDefault: cfgLlm.presence_penalty === undefined,
      presence_penalty: cfgLlm.presence_penalty ?? initial.llm.presence_penalty,
      reasoningEffortUseDefault: cfgLlm.reasoning_effort === undefined,
      reasoning_effort: (cfgLlm.reasoning_effort as AgentFormData['llm']['reasoning_effort']) || 'none',
      responseFormatUseDefault: cfgLlm.response_format === undefined,
      response_format: (cfgLlm.response_format as AgentFormData['llm']['response_format']) || 'text',
    },
    behavior: {
      mode: (cfgBehavior.mode as AgentFormData['behavior']['mode']) || 'loop',
      max_turns: cfgBehavior.max_turns ?? initial.behavior.max_turns,
      herdar_contexto: cfgBehavior.herdar_contexto ?? initial.behavior.herdar_contexto,
      debounce_ms: cfgBehavior.debounce_ms ?? initial.behavior.debounce_ms,
      stall_seconds: cfgBehavior.stall_seconds ?? initial.behavior.stall_seconds,
    },
    recovery: {
      attempt_retries: cfgRecovery.attempt_retries ?? initial.recovery.attempt_retries,
      empty_reply_text: cfgRecovery.empty_reply_text ?? initial.recovery.empty_reply_text,
      integration_failure_text: cfgRecovery.integration_failure_text ?? initial.recovery.integration_failure_text,
      integration_failure_tag: cfgRecovery.integration_failure_tag ?? initial.recovery.integration_failure_tag,
    },
    protections: {
      anti_xingamento: cfgProtections.anti_xingamento?.enabled ?? true,
      anti_loop: cfgProtections.anti_loop?.enabled ?? true,
      pedido_humano_contestacao: cfgProtections.pedido_humano_contestacao?.enabled ?? true,
      pessoa_errada: cfgProtections.pessoa_errada?.enabled ?? true,
    },
    execution: {
      llm_timeout_ms: cfgExecution.llm_timeout_ms ?? initial.execution.llm_timeout_ms,
    },
  };
}

/**
 * Config a enviar à API. Com `existingConfig` (editando um agente), parte DELE e só sobrescreve o que
 * o formulário edita — o resto (tags de saída, mídia, conexões, flags legadas…) é preservado, para
 * que salvar pela tela não apague configuração vinda da conversão ou de outras versões.
 */
export function formDataToAgentConfig(
  formData: AgentFormData,
  existingConfig?: AgentConfig | null,
): AgentConfig {
  const fresh = buildFreshConfig(formData, existingConfig);
  if (!existingConfig) return fresh;
  const merged = structuredClone(existingConfig);
  const editableLlm = [
    'temperature', 'max_tokens', 'max_output_tokens', 'top_p', 'frequency_penalty',
    'presence_penalty', 'reasoning_effort', 'response_format', 'model',
  ] as const;
  const llm = { ...merged.llm } as Record<string, unknown>;
  for (const key of editableLlm) delete llm[key];
  merged.llm = { ...llm, ...fresh.llm } as AgentConfig['llm'];
  merged.behavior = {
    ...merged.behavior,
    mode: fresh.behavior.mode,
    max_turns: fresh.behavior.max_turns,
    herdar_contexto: fresh.behavior.herdar_contexto,
    debounce_ms: fresh.behavior.debounce_ms,
    stall_seconds: fresh.behavior.stall_seconds,
  };
  merged.recovery = {
    ...merged.recovery,
    attempt_retries: fresh.recovery.attempt_retries,
    empty_reply_text: fresh.recovery.empty_reply_text,
    integration_failure_text: fresh.recovery.integration_failure_text,
    integration_failure_tag: fresh.recovery.integration_failure_tag,
  };
  merged.protections = {
    ...merged.protections,
    anti_xingamento: { ...merged.protections.anti_xingamento, enabled: fresh.protections.anti_xingamento.enabled },
    anti_loop: { ...merged.protections.anti_loop, enabled: fresh.protections.anti_loop.enabled },
    pedido_humano_contestacao: { ...merged.protections.pedido_humano_contestacao, enabled: fresh.protections.pedido_humano_contestacao.enabled },
    pessoa_errada: { ...merged.protections.pessoa_errada, enabled: fresh.protections.pessoa_errada.enabled },
  };
  const knowledge = { ...merged.knowledge, selection_mode: fresh.knowledge.selection_mode } as AgentConfig['knowledge'];
  if (fresh.knowledge.file_ids) knowledge.file_ids = fresh.knowledge.file_ids;
  else delete knowledge.file_ids;
  knowledge.rag_external = { ...merged.knowledge.rag_external, ...fresh.knowledge.rag_external };
  if (!fresh.knowledge.rag_external.url) delete knowledge.rag_external.url;
  if (!fresh.knowledge.rag_external.credential) delete knowledge.rag_external.credential;
  merged.knowledge = knowledge;
  merged.tools = fresh.tools;
  merged.execution = { ...merged.execution, llm_timeout_ms: fresh.execution.llm_timeout_ms };
  return merged;
}

function buildFreshConfig(
  formData: AgentFormData,
  existingConfig?: AgentConfig | null,
): AgentConfig {
  const defaults = LEGACY_AGENT_DEFAULTS;
  const provider = formData.llm.provider;

  const llmConfig: AgentConfig['llm'] = {
    provider,
    model: formData.llm.model.trim() || undefined,
  };

  if (!formData.llm.temperatureUseDefault && typeof formData.llm.temperature === 'number') {
    llmConfig.temperature = formData.llm.temperature;
  }

  if (!formData.llm.maxTokensUseDefault && typeof formData.llm.max_tokens === 'number') {
    if (provider === 'gemini') {
      llmConfig.max_output_tokens = formData.llm.max_tokens;
    } else {
      llmConfig.max_tokens = formData.llm.max_tokens;
    }
  }

  if (!formData.llm.topPUseDefault && typeof formData.llm.top_p === 'number') {
    llmConfig.top_p = formData.llm.top_p;
  }

  if (!formData.llm.frequencyPenaltyUseDefault && typeof formData.llm.frequency_penalty === 'number') {
    llmConfig.frequency_penalty = formData.llm.frequency_penalty;
  }

  if (!formData.llm.presencePenaltyUseDefault && typeof formData.llm.presence_penalty === 'number') {
    llmConfig.presence_penalty = formData.llm.presence_penalty;
  }

  if (!formData.llm.reasoningEffortUseDefault && formData.llm.reasoning_effort) {
    llmConfig.reasoning_effort = formData.llm.reasoning_effort;
  }

  if (!formData.llm.responseFormatUseDefault && formData.llm.response_format) {
    llmConfig.response_format = formData.llm.response_format;
  }

  const ragExternal = formData.knowledge.rag_external.enabled
    ? {
        enabled: true,
        url: formData.knowledge.rag_external.url.trim() || undefined,
        credential: formData.knowledge.rag_external.credential.trim() || undefined,
        top_k: formData.knowledge.rag_external.top_k,
        timeout_ms: formData.knowledge.rag_external.timeout_ms,
        max_bytes: defaults.knowledge.rag_external.max_bytes,
        max_context_chars: defaults.knowledge.rag_external.max_context_chars,
        max_redirects: defaults.knowledge.rag_external.max_redirects,
        retries: defaults.knowledge.rag_external.retries,
        failure_policy: defaults.knowledge.rag_external.failure_policy,
      }
    : {
        enabled: false,
        top_k: defaults.knowledge.rag_external.top_k,
        timeout_ms: defaults.knowledge.rag_external.timeout_ms,
        max_bytes: defaults.knowledge.rag_external.max_bytes,
        max_context_chars: defaults.knowledge.rag_external.max_context_chars,
        max_redirects: defaults.knowledge.rag_external.max_redirects,
        retries: defaults.knowledge.rag_external.retries,
        failure_policy: defaults.knowledge.rag_external.failure_policy,
      };

  return {
    schema_version: 1,
    llm: llmConfig,
    prompt: {
      source: 'account',
      account_content: formData.prompt_content,
      legacy_override_present: false,
    },
    behavior: {
      mode: formData.behavior.mode,
      max_turns: formData.behavior.max_turns,
      herdar_contexto: formData.behavior.herdar_contexto,
      debounce_ms: formData.behavior.debounce_ms,
      standalone_debounce_threshold_ms: defaults.behavior.standalone_debounce_threshold_ms,
      free_turns: defaults.behavior.free_turns,
      free_media_types: [...defaults.behavior.free_media_types],
      ack_words: [...defaults.behavior.ack_words],
      chain_policy: defaults.behavior.chain_policy,
      exit_tags: [...KNOWN_AI_EXIT_TAGS],
      handoff_policy: defaults.behavior.handoff_policy,
      disabled_policy: defaults.behavior.disabled_policy,
      stall_seconds: formData.behavior.stall_seconds,
      stall_max_minutes: defaults.behavior.stall_max_minutes,
      legacy_ben_auto_exit: false,
      legacy_flow_controlled: false,
    },
    recovery: {
      attempt_retries: formData.recovery.attempt_retries,
      attempt_delay_ms: defaults.recovery.attempt_delay_ms,
      empty_reply_retries: defaults.recovery.empty_reply_retries,
      empty_reply_delay_ms: defaults.recovery.empty_reply_delay_ms,
      empty_reply_text: formData.recovery.empty_reply_text,
      integration_failure_text: formData.recovery.integration_failure_text,
      integration_failure_tag: formData.recovery.integration_failure_tag,
      tool_max_attempts: defaults.recovery.tool_max_attempts,
      tool_retry_names: [...defaults.recovery.tool_retry_names],
      tool_retry_methods: [...defaults.recovery.tool_retry_methods],
      tool_backoff_ms: defaults.recovery.tool_backoff_ms,
      tool_backoff_cap_ms: defaults.recovery.tool_backoff_cap_ms,
      retry_before_external_effect_only: defaults.recovery.retry_before_external_effect_only,
    },
    protections: {
      anti_xingamento: {
        enabled: formData.protections.anti_xingamento,
        action: 'team_queue',
      },
      anti_loop: {
        enabled: formData.protections.anti_loop,
        min_messages: defaults.protections.anti_loop.min_messages,
        window_seconds: defaults.protections.anti_loop.window_seconds,
        future_tolerance_ms: defaults.protections.anti_loop.future_tolerance_ms,
        action: 'team_queue',
      },
      pedido_humano_contestacao: {
        enabled: formData.protections.pedido_humano_contestacao,
      },
      pessoa_errada: {
        enabled: formData.protections.pessoa_errada,
      },
    },
    knowledge: {
      selection_mode: formData.knowledge.selection_mode,
      kb_enabled: defaults.knowledge.kb_enabled,
      ...(formData.knowledge.selection_mode === 'explicit' && formData.knowledge.file_ids.length > 0
        ? { file_ids: formData.knowledge.file_ids }
        : {}),
      max_chars: defaults.knowledge.max_chars,
      query_customer_messages: defaults.knowledge.query_customer_messages,
      ranking: defaults.knowledge.ranking,
      name_weight: defaults.knowledge.name_weight,
      body_weight: defaults.knowledge.body_weight,
      min_term_chars: defaults.knowledge.min_term_chars,
      stopwords: [...defaults.knowledge.stopwords],
      min_partial_chars: defaults.knowledge.min_partial_chars,
      truncation_note: defaults.knowledge.truncation_note,
      rag_external: ragExternal,
    },
    tools: formData.tools.map((t) => ({
      tool_id: t.tool_id,
      enabled: t.enabled,
    })),
    rules: [],
    media: {
      multimodal_enabled: defaults.media.multimodal_enabled,
      image_policy: defaults.media.image_policy,
      placeholders_version: defaults.media.placeholders_version,
      stt: { ...defaults.media.stt },
      voice: { ...defaults.media.voice },
    },
    execution: {
      ...defaults.execution,
      llm_timeout_ms: formData.execution.llm_timeout_ms,
    },
    connections: existingConfig?.connections ?? {
      llm: defaults.connections[provider],
      stt: defaults.connections.stt,
      tts: defaults.connections.tts,
      ddm: defaults.connections.ddm,
    },
    legacy: existingConfig?.legacy ?? {
      account_id: '00000000-0000-0000-0000-000000000000',
      account_enabled: true,
      policy_version: 'responder_v1',
      google_search_requested: false,
      ssrf_allowed_hosts: [],
      ddm: defaults.ddm,
      immutable_limits: defaults.immutable_limits,
    },
  };
}

export function formDataToSavePayload(
  formData: AgentFormData,
  existingConfig?: AgentConfig | null,
): SaveAgentPayload {
  const config = formDataToAgentConfig(formData, existingConfig);
  const rules = formData.rules.map((r) => ({
    content: r.content,
    enabled: r.enabled,
  }));
  const tool_ids = formData.tools.map((t) => t.tool_id).filter(Boolean);
  const knowledge: SaveAgentPayload['knowledge'] = {
    selection_mode: formData.knowledge.selection_mode,
    ...(formData.knowledge.selection_mode === 'explicit' ? { file_ids: formData.knowledge.file_ids } : {}),
  };

  return {
    name: formData.name.trim(),
    config,
    prompt_content: formData.prompt_content,
    composition: 'sections_v1',
    rules,
    tool_ids,
    knowledge,
  };
}

export function formDataToPreviewPayload(
  formData: AgentFormData,
  existingConfig?: AgentConfig | null,
): PreviewAgentPayload {
  const config = formDataToAgentConfig(formData, existingConfig);
  const rules = formData.rules.map((r) => ({
    content: r.content,
    enabled: r.enabled,
  }));
  const knowledge: PreviewAgentPayload['knowledge'] = {
    selection_mode: formData.knowledge.selection_mode,
    ...(formData.knowledge.selection_mode === 'explicit' ? { file_ids: formData.knowledge.file_ids } : {}),
  };

  return {
    config,
    prompt_content: formData.prompt_content,
    composition: 'sections_v1',
    rules,
    knowledge,
  };
}
