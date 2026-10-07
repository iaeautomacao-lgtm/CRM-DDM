import { createHash } from "node:crypto";
import type { AiAgentNodeConfig, AiAgentTool } from "@/lib/flows/types";
import { getAiModelDefinition, isAiProvider, isModelCompatibleWithProvider, resolveAiModel } from "../models";
import { KNOWN_AI_EXIT_TAGS } from "../exit-tags";
import { LEGACY_AGENT_DEFAULTS, parseAgentConfig, type AgentConfig, type AgentPromptVersion } from "./schema";

export interface LegacyAccountAiConfig {
  account_id: string;
  enabled: boolean;
  api_provider: string;
  api_model?: string | null;
  api_key?: string | null;
  system_prompt?: string | null;
  google_search_enabled?: boolean;
  multimodal_enabled?: boolean;
  elevenlabs_enabled?: boolean;
  elevenlabs_api_key?: string | null;
  elevenlabs_voice_id?: string | null;
  elevenlabs_model_id?: string | null;
}
export interface ConversionContext {
  node_key?: string;
  flow_exit_tags?: string[];
  kb_files?: { id?: string; name: string; content: string | null }[];
  credential_refs?: { llm?: string; tts?: string; ddm?: string; stt?: string };
  tool_ids?: string[];
  // Injetar o snapshot do ambiente do servidor; nunca valores de secrets.
  env?: Record<string, string | undefined>;
}
export interface ConvertedAgent extends AgentPromptVersion {
  hash: string;
  enabled: boolean;
  rules: [];
}

/** Ordena chaves recursivamente; ordem de arrays é parte do contrato. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + Array.from(value, canonicalJson).join(",") + "]";
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson((value as Record<string, unknown>)[key])).join(",") + "}";
  }
  throw new Error("Hash exige JSON finito sem undefined/protótipos especiais.");
}
function hashJson(value: unknown): string { return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex"); }
export function hashAgentVersion(version: AgentPromptVersion): string {
  return hashJson({ config: parseAgentConfig(version.config), composition: version.composition, prompt_content: version.prompt_content });
}

function envInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const value = Number.parseInt(env[key] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
function configuredCredential(present: string | null | undefined, ref: string | undefined, purpose: string): string | undefined {
  if (present?.trim() && !ref) throw new Error(`Converta a credencial ${purpose} para o cofre antes de converter o perfil.`);
  return ref;
}
function assertToolSecretReferences(tool: AiAgentTool): void {
  // Não copiar tokens literais para outra tabela. A fase 2 deve fornecer o mapping.
  const marker = /\{\{(?:cred\.[A-Z][A-Z0-9_]{1,63}|secret\.DDM_TOKEN)\}\}/;
  for (const [key, value] of Object.entries(tool.http.headers ?? {})) {
    if (/^(authorization|proxy-authorization|x-api-key|.*token.*|.*secret.*)$/i.test(key) && !marker.test(value)) {
      throw new Error("Ferramenta contém credencial literal; migre para o cofre.");
    }
  }
  const url = new URL(tool.http.url);
  if (url.username || url.password) throw new Error("Ferramenta contém credencial na autoridade da URL.");
  for (const [key, value] of url.searchParams) {
    if (/^(tk|token|api_?key|key|secret)$/i.test(key) && !marker.test(value)) throw new Error("Ferramenta contém credencial literal na URL.");
  }
}

function convert(node: AiAgentNodeConfig | null, account: LegacyAccountAiConfig, context: ConversionContext): ConvertedAgent {
  if (!isAiProvider(account.api_provider)) throw new Error("Provider legado inválido.");
  if (node?.model?.trim() && !isModelCompatibleWithProvider(node.model, account.api_provider)) throw new Error("Modelo do nó incompatível com o provider da conta.");
  const resolved = resolveAiModel({ provider: account.api_provider, nodeModel: node?.model, accountModel: account.api_model });
  if (!resolved) throw new Error("Modelo legado não resolvido.");
  const defaults = LEGACY_AGENT_DEFAULTS;
  const env = context.env ?? {};
  const provider = account.api_provider;
  const reasoning = getAiModelDefinition(provider, resolved.model)?.openai_chat?.reasoning_effort;
  const llm: AgentConfig["llm"] = { provider, model: resolved.model };
  if (provider === "openai" && reasoning) { llm.reasoning_effort = reasoning; llm.max_completion_tokens = defaults.llm.max_tokens; }
  else {
    if (provider !== "claude") llm.temperature = defaults.llm.temperature;
    if (provider === "gemini") llm.max_output_tokens = defaults.llm.max_tokens;
    else llm.max_tokens = defaults.llm.max_tokens;
  }
  const tools = node?.tools ?? [];
  tools.forEach(assertToolSecretReferences);
  if (context.tool_ids && context.tool_ids.length !== tools.length) throw new Error("Mapping de tools deve preservar quantidade e ordem.");
  if (provider === "openai" && tools.length) llm.tool_choice = "auto";
  const llmRef = configuredCredential(account.api_key, context.credential_refs?.llm, "llm");
  const ttsRef = configuredCredential(account.elevenlabs_api_key, context.credential_refs?.tts, "tts");
  const platformKeys = provider === "claude" ? ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY"]
    : [provider === "openai" ? "OPENAI_API_KEY" : provider === "gemini" ? "GEMINI_API_KEY" : "OPENROUTER_API_KEY"];
  const overridePresent = node?.system_prompt_override !== undefined;
  const override = node?.system_prompt_override;
  const accountPrompt = account.system_prompt ?? "";
  const promptContent = overridePresent ? override! : accountPrompt;
  const config = parseAgentConfig({
    schema_version: 1, llm,
    prompt: { source: override?.trim() ? "node" : accountPrompt ? "account" : "default", account_content: accountPrompt, legacy_override_present: overridePresent },
    behavior: {
      ...defaults.behavior, mode: node?.mode ?? "loop", max_turns: node?.max_turns ?? defaults.behavior.max_turns,
      herdar_contexto: node?.herdar_contexto_anterior ?? defaults.behavior.herdar_contexto,
      exit_tags: [...KNOWN_AI_EXIT_TAGS, ...(context.flow_exit_tags ?? [])],
      stall_seconds: envInt(env, "AI_STALL_SECONDS", defaults.behavior.stall_seconds),
      stall_max_minutes: envInt(env, "AI_STALL_MAX_MINUTES", defaults.behavior.stall_max_minutes),
      legacy_ben_auto_exit: node !== null && context.node_key === "agente_de_ia",
      legacy_flow_controlled: node !== null,
    },
    recovery: defaults.recovery, protections: defaults.protections,
    knowledge: {
      ...defaults.knowledge, selection_mode: "legacy_account_all",
      max_chars: envInt(env, "AI_KB_MAX_CHARS", defaults.knowledge.max_chars),
      files: (context.kb_files ?? []).map((f) => ({ ...(f.id ? { id: f.id } : {}), name: f.name, content_hash: hashJson(f.content) })),
    },
    tools: tools.map((definition, i) => ({ ...(context.tool_ids ? { tool_id: context.tool_ids[i] } : {}), enabled: true, definition })),
    rules: [],
    media: {
      ...defaults.media, multimodal_enabled: account.multimodal_enabled ?? false,
      voice: { ...defaults.media.voice, enabled: account.elevenlabs_enabled ?? false,
        voice_id: account.elevenlabs_voice_id ? account.elevenlabs_voice_id : defaults.media.voice.voice_id,
        ...(account.elevenlabs_model_id !== undefined && account.elevenlabs_model_id !== null ? { requested_model_id: account.elevenlabs_model_id } : {}),
      },
    },
    execution: {
      ...defaults.execution,
      history_scope: node === null ? "conversation" : defaults.execution.history_scope,
      concurrency: envInt(env, "AI_LLM_MAX_CONCURRENCY", defaults.execution.concurrency),
      queue_wait_ms: envInt(env, "AI_LLM_QUEUE_MAX_WAIT_MS", defaults.execution.queue_wait_ms),
      rate_limit_retries: envInt(env, "AI_LLM_429_MAX_RETRIES", defaults.execution.rate_limit_retries),
      rate_limit_max_wait_ms: envInt(env, "AI_LLM_429_MAX_WAIT_MS", defaults.execution.rate_limit_max_wait_ms),
    },
    connections: {
      llm: { ...defaults.connections[provider], ...(llmRef ? { credential: llmRef } : {}), platform_env: platformKeys },
      stt: provider === "openai" ? { ...defaults.connections.stt, ...(llmRef ? { credential: llmRef } : {}), platform_env: platformKeys }
        : { ...defaults.connections.stt, ...(context.credential_refs?.stt ? { credential: context.credential_refs.stt } : {}), platform_env: ["OPENAI_API_KEY"] },
      tts: { ...defaults.connections.tts, ...(ttsRef ? { credential: ttsRef } : {}) },
      ddm: { ...defaults.connections.ddm, ...(context.credential_refs?.ddm ? { credential: context.credential_refs.ddm } : {}), platform_env: ["DDM_ACORDOS_API_TOKEN", "DDM_TOKEN", "DDM_API_KEY"] },
    },
    analysis: provider === "claude"
      ? { history_limit: defaults.analysis.history_limit, timeout_ms: defaults.analysis.timeout_ms, max_tokens: defaults.analysis.max_tokens }
      : { ...defaults.analysis, ...(reasoning ? { reasoning_effort: reasoning } : {}) },
    legacy: {
      account_id: account.account_id, account_enabled: account.enabled, policy_version: "responder_v1",
      google_search_requested: account.google_search_enabled ?? false,
      ssrf_allowed_hosts: (env.SSRF_ALLOWED_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
      ddm: defaults.ddm, immutable_limits: defaults.immutable_limits,
    },
  });
  const version: AgentPromptVersion = { config, prompt_content: promptContent, composition: "legacy_v1" };
  return { ...version, enabled: account.enabled, rules: [], hash: hashAgentVersion(version) };
}

export function convertAiAgentNode(node: AiAgentNodeConfig, account: LegacyAccountAiConfig, context: ConversionContext = {}): ConvertedAgent {
  if (!context.node_key) throw new Error("Conversão exige node_key real para preservar a policy BEN.");
  return convert(node, account, context);
}
export function convertGlobalResponder(account: LegacyAccountAiConfig, context: ConversionContext = {}): ConvertedAgent {
  return convert(null, account, context);
}
export function deduplicateAgents(agents: readonly ConvertedAgent[]): { profiles: ConvertedAgent[]; profile_indexes: number[] } {
  const profiles: ConvertedAgent[] = [];
  const byHash = new Map<string, number>();
  const profile_indexes = agents.map((agent) => {
    // Recalcular: não confiar em hash fornecido pelo caller ou config mutada após a conversão.
    const hash = hashAgentVersion(agent);
    const key = `${hash}:${agent.enabled}`;
    const existing = byHash.get(key);
    if (existing !== undefined) return existing;
    const index = profiles.length;
    profiles.push({ ...structuredClone(agent), hash });
    byHash.set(key, index);
    return index;
  });
  return { profiles, profile_indexes };
}
