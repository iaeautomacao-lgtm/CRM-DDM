import { describe, expect, it } from "vitest";
import type { AiAgentNodeConfig, AiAgentTool } from "@/lib/flows/types";
import { canonicalJson, convertAiAgentNode, convertGlobalResponder, deduplicateAgents, hashAgentVersion, type LegacyAccountAiConfig } from "./convert";
import { validateAgentConfig } from "./schema";

export const ACCOUNT: LegacyAccountAiConfig = {
  account_id: "00000000-0000-0000-0000-00000000000a", enabled: true, api_provider: "openai", system_prompt: "Prompt da conta",
};
export const TOOL: AiAgentTool = {
  name: "consultar_debitos", description: "Consulta débitos", parameters: { type: "object", properties: {
    registro: { type: "string", description: "Registro" },
  }, required: ["registro"] }, http: { url: "https://ddmacordos.com/calc/?tk={{secret.DDM_TOKEN}}&id={{registro}}", method: "GET" },
};
const node: AiAgentNodeConfig = { mode: "loop", max_turns: 20, system_prompt_override: "  Prompt {{vars.nome}}\r\n", tools: [TOOL] };
const context = { node_key: "agente_ddm" };
const convert = (config = node, account = ACCOUNT) => convertAiAgentNode(config, account, context);

describe("conversão e hash de perfis", () => {
  it("preserva defaults efetivos, bytes, rules vazias, KB de conta e não resolve segredo", () => {
    const result = convert();
    expect(result.composition).toBe("legacy_v1");
    expect(result.prompt_content).toBe(node.system_prompt_override);
    expect(result.rules).toEqual([]);
    expect(result.config.rules).toEqual([]);
    expect(result.config.knowledge.selection_mode).toBe("legacy_account_all");
    expect(result.config.knowledge.rag_external.enabled).toBe(false);
    expect(result.config.tools[0]).toEqual({ enabled: true, definition: TOOL });
    expect(result.config.llm).toEqual({ provider: "openai", model: "gpt-4o-mini", temperature: 0.7, max_tokens: 1000, tool_choice: "auto" });
    expect(result.config.execution).toMatchObject({ concurrency: 20, queue_wait_ms: 60000, tool_timeout_ms: 30000 });
    expect(validateAgentConfig(result.config).success).toBe(true);
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("dois nós efetivamente iguais deduplicam mesmo com destinos distintos", () => {
    const a = convert({ ...node, next_node_key: "switch_a" });
    const b = convert({ ...node, next_node_key: "switch_b" });
    expect(deduplicateAgents([a, b]).profile_indexes).toEqual([0, 0]);
    expect(deduplicateAgents([a, b]).profiles).toHaveLength(1);
  });
  it.each(["provider", "KB", "tags", "herança", "mode", "turnos", "prompt", "conexão", "env", "conta", "ordem tools", "ordem KB", "BEN"])("diferença em %s impede dedupe", (field) => {
    const kb = [{ name: "a", content: "aaa" }, { name: "b", content: "bbb" }];
    const a = convertAiAgentNode(node, ACCOUNT, { ...context, kb_files: kb });
    const changes: Record<string, () => ReturnType<typeof convert>> = {
      provider: () => convertAiAgentNode(node, { ...ACCOUNT, api_provider: "gemini" }, { ...context, kb_files: kb }),
      KB: () => convertAiAgentNode(node, ACCOUNT, { ...context, kb_files: [{ name: "a", content: "outra" }, kb[1]] }),
      tags: () => convertAiAgentNode(node, ACCOUNT, { ...context, kb_files: kb, flow_exit_tags: ["#OUTRA"] }),
      herança: () => convertAiAgentNode({ ...node, herdar_contexto_anterior: true }, ACCOUNT, { ...context, kb_files: kb }),
      mode: () => convertAiAgentNode({ ...node, mode: "once" }, ACCOUNT, { ...context, kb_files: kb }),
      turnos: () => convertAiAgentNode({ ...node, max_turns: 2 }, ACCOUNT, { ...context, kb_files: kb }),
      prompt: () => convertAiAgentNode({ ...node, system_prompt_override: "outro" }, ACCOUNT, { ...context, kb_files: kb }),
      conexão: () => convertAiAgentNode(node, ACCOUNT, { ...context, kb_files: kb, credential_refs: { llm: "{{cred.LLM_KEY}}" } }),
      env: () => convertAiAgentNode(node, ACCOUNT, { ...context, kb_files: kb, env: { AI_KB_MAX_CHARS: "5000" } }),
      conta: () => convertAiAgentNode(node, { ...ACCOUNT, account_id: "00000000-0000-0000-0000-00000000000b" }, { ...context, kb_files: kb }),
      "ordem tools": () => {
        const other = { ...TOOL, name: "localizar_devedor" };
        return convertAiAgentNode({ ...node, tools: [other, TOOL] }, ACCOUNT, { ...context, kb_files: kb });
      },
      "ordem KB": () => convertAiAgentNode(node, ACCOUNT, { ...context, kb_files: [...kb].reverse() }),
      BEN: () => convertAiAgentNode(node, ACCOUNT, { node_key: "agente_de_ia", kb_files: kb }),
    };
    expect(deduplicateAgents([a, changes[field]()]).profiles).toHaveLength(2);
  });
  it("ordem das mesmas tools muda hash; ordem das chaves não", () => {
    const other = { ...TOOL, name: "localizar_devedor" };
    expect(convert({ ...node, tools: [TOOL, other] }).hash).not.toBe(convert({ ...node, tools: [other, TOOL] }).hash);
    expect(canonicalJson({ b: { y: 2, x: 1 }, a: 0 })).toBe(canonicalJson({ a: 0, b: { x: 1, y: 2 } }));
    expect(() => canonicalJson({ missing: undefined })).toThrow();
    expect(() => canonicalJson([Infinity])).toThrow();
    expect(() => canonicalJson(new Array(1))).toThrow();
  });
  it("vínculos ordenados de regras e toggles fazem parte do hash completo", () => {
    const a = convert(); const b = convert();
    b.config.rules = [{ rule_version_id: "00000000-0000-0000-0000-000000000001", position: 0, enabled: true, content_hash: "a".repeat(64) }];
    expect(hashAgentVersion(a)).not.toBe(hashAgentVersion(b));
    const c = structuredClone(b); c.config.rules[0].enabled = false;
    expect(hashAgentVersion(b)).not.toBe(hashAgentVersion(c));
  });
  it("Claude e reasoning preservam temperatura omitida; flags ignoradas não ativam search/TTS model salvo", () => {
    const claude = convert(node, { ...ACCOUNT, api_provider: "claude", elevenlabs_model_id: "eleven_turbo_v2_5", google_search_enabled: true });
    expect(claude.config.llm).not.toHaveProperty("temperature");
    expect(claude.config.llm).not.toHaveProperty("search_enabled");
    expect(claude.config.media.voice?.model_id).toBe("eleven_multilingual_v2");
    expect(claude.config.media.voice?.requested_model_id).toBe("eleven_turbo_v2_5");
    const reasoning = convert({ ...node, model: "gpt-6-luna" });
    expect(reasoning.config.llm).toMatchObject({ reasoning_effort: "none", max_completion_tokens: 1000 });
    expect(reasoning.config.llm).not.toHaveProperty("temperature");
    expect(reasoning.config.llm).not.toHaveProperty("max_tokens");
  });
  it("conexões e subpolicy de análise registram defaults não secretos por provider", () => {
    const a = convert();
    expect(a.config.connections.llm?.endpoint).toBe("https://api.openai.com/v1/chat/completions");
    expect(a.config.analysis).toMatchObject({ temperature: 0.2, max_tokens: 500, timeout_ms: 20000 });
    const claude = convert(node, { ...ACCOUNT, api_provider: "claude" });
    expect(claude.config.connections.llm?.headers).toMatchObject({ "anthropic-version": "2023-06-01" });
    expect(claude.config.analysis).not.toHaveProperty("temperature");
    expect(claude.config.analysis).not.toHaveProperty("response_format");
  });
  it("snapshot de env usa a mesma leitura positiva do legado, sem ler secrets", () => {
    const a = convertAiAgentNode(node, ACCOUNT, { ...context, env: { AI_LLM_MAX_CONCURRENCY: "7", AI_LLM_429_MAX_RETRIES: "0", AI_KB_MAX_CHARS: "1234", DDM_TOKEN: "nao-persistir" } });
    expect(a.config.execution.concurrency).toBe(7);
    expect(a.config.execution.rate_limit_retries).toBe(2);
    expect(a.config.knowledge.max_chars).toBe(1234);
    expect(JSON.stringify(a)).not.toContain("nao-persistir");
  });
  it("credenciais configuradas exigem mapping para o cofre e nunca entram no JSON", () => {
    expect(() => convert(node, { ...ACCOUNT, api_key: "segredo-configurado" })).toThrow(/cofre/);
    const a = convertAiAgentNode(node, { ...ACCOUNT, api_key: "segredo-configurado" }, { ...context, credential_refs: { llm: "{{cred.LLM_KEY}}" } });
    expect(JSON.stringify(a)).not.toContain("segredo-configurado");
    expect(() => convert({ ...node, tools: [{ ...TOOL, http: { url: "https://a.test/?tk=token", method: "GET" } }] })).toThrow(/literal/);
  });
  it("responder global não vira override e preserva janela de conversa", () => {
    const a = convertGlobalResponder(ACCOUNT);
    expect(a.config.prompt.legacy_override_present).toBe(false);
    expect(a.config.behavior.legacy_flow_controlled).toBe(false);
    expect(a.config.execution.history_scope).toBe("conversation");
    expect(a.prompt_content).toBe(ACCOUNT.system_prompt);
    expect(() => convertAiAgentNode(node, ACCOUNT)).toThrow(/node_key/);
  });
  it("recalcula hash e isola dados do caller durante dedupe", () => {
    const a = convert(); const b = convert(); b.config.llm.temperature = 0;
    const result = deduplicateAgents([a, b]);
    expect(result.profiles).toHaveLength(2);
    expect(result.profiles[1].hash).toBe(hashAgentVersion(b));
    a.config.llm.temperature = 2;
    expect(result.profiles[0].config.llm.temperature).toBe(0.7);
  });
});
