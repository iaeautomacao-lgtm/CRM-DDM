import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { composeAgentPrompt } from "./compose";
import { composeLegacyDdm, type LegacyDdmContext } from "./legacy-compose";
import { convertAiAgentNode, convertGlobalResponder } from "./convert";
import { buildKnowledgeBaseContext } from "../kb-context";

const account = { account_id: "00000000-0000-0000-0000-00000000000a", enabled: true, api_provider: "openai", system_prompt: "Prompt global" };
const engine = readFileSync("src/lib/flows/engine.ts", "utf8");
const routingFixture = readFileSync("src/lib/flows/exit-tag-routing.test.ts", "utf8");
const officialPrompts = ["AGENTE_DDM_PROMPT", "RECOVERY_PROMPT"].map((name) => {
  const match = routingFixture.match(new RegExp("const " + name + " = `([\\s\\S]*?)`;"));
  if (!match) throw new Error(`Fixture oficial ${name} ausente.`);
  return match[1];
});

// Goldens CONGELADOS (legacy-prompt.golden.json), capturados do responder.ts original ANTES de
// ele passar a usar este compositor (deduplicação, Fase 4): a comparação byte a byte agora é com
// o texto histórico, não com um trecho extraído do código atual (que deixou de existir lá).
interface GoldenDdm {
  name: string; base: string; hasOverride: boolean; accountPrompt: string;
  ddm_data: LegacyDdmContext["ddm_data"]; found_cpf: string | null; today_utc: string; current_date: string;
  expected: { systemPrompt: string; forcedReply: string };
}
const golden = JSON.parse(readFileSync("src/lib/ai/agents/golden/legacy-prompt.golden.json", "utf8")) as {
  ddm: GoldenDdm[]; kb: { base: string; kb: string; expected: string };
};
const goldenCase = (name: string, accountPrompt = "Prompt global") => {
  const found = golden.ddm.find((c) => c.name === name && c.accountPrompt === accountPrompt && !c.hasOverride);
  if (!found) throw new Error("golden ausente: " + name);
  return found;
};
// Sufixo fixo "informação obrigatória antes de iniciar" (sem CPF, sem DDM, sem override).
const noCpfSuffix = goldenCase("sem-cpf-sem-ddm").expected.systemPrompt.slice("base KB".length);
const kbTemplate = golden.kb.expected.replace(golden.kb.base, "@@BASE@@").replace(golden.kb.kb, "@@KB@@");
const referenceKb = (base: string, kb: string) => kbTemplate.replace("@@BASE@@", () => base).replace("@@KB@@", () => kb);
const inheritStart = engine.indexOf("        const contextoAnterior =");
const inheritEnd = engine.indexOf("        enrichedSystemPromptOverride =", inheritStart);
const referenceInherit = new Function("listaFerramentas", "blocos", engine.slice(inheritStart, inheritEnd) + "return contextoAnterior;") as (tools: string, blocks: string[]) => string;

describe("compositor de prompt — golden contra código atual", () => {
  it.each(officialPrompts)("nó oficial mantém prompt idêntico byte a byte", (prompt) => {
    const version = convertAiAgentNode({ mode: "loop", max_turns: 20, system_prompt_override: prompt }, account, { node_key: "agente_ddm" });
    expect(Buffer.from(composeAgentPrompt(version))).toEqual(Buffer.from(prompt));
  });
  it("KB e herança correspondem aos delimitadores atuais, ordem e truncagem", () => {
    const prompt = officialPrompts[1] + "\r\nCPF={{vars.cpf}}";
    const version = convertAiAgentNode({ mode: "loop", max_turns: 2, herdar_contexto_anterior: true, system_prompt_override: prompt, tools: [] }, account, { node_key: "recovery_recusa" });
    const files = [{ name: "parcelas.txt", content: "1x à vista" }];
    const result = "x".repeat(3001);
    const inherited = referenceInherit("consultar_debitos", [`[tool: consultar_debitos]\n${result.slice(0, 3000)}…`]);
    const expected = referenceKb(prompt.replace("{{vars.cpf}}", "123") + "\n\n---\n" + inherited, buildKnowledgeBaseContext(files, "", 40000));
    expect(composeAgentPrompt(version, { vars: { cpf: "123" }, current_node_key: "recovery_recusa", kb_files: files,
      previous_tool_results: [{ node_key: "agente_ddm", tool_name: "consultar_debitos", result },
        { node_key: "recovery_recusa", tool_name: "propria", result: "não herdar" }] })).toBe(expected);
  });
  it("sem override ou somente whitespace usa global e blocos fixos atuais", () => {
    for (const prompt of [undefined, "", " \r\n "]) {
      const version = convertAiAgentNode({ mode: "once", ...(prompt !== undefined ? { system_prompt_override: prompt } : {}) }, account, { node_key: "outro" });
      expect(composeAgentPrompt(version)).toBe(account.system_prompt + noCpfSuffix);
    }
  });
  it("fallback interno/global e herança sem override conservam a semântica legada", () => {
    const global = convertGlobalResponder({ ...account, system_prompt: "" });
    expect(composeAgentPrompt(global)).toBe("Você é um assistente virtual. Aguarde um momento." + noCpfSuffix);
    const version = convertAiAgentNode({ mode: "loop", herdar_contexto_anterior: true }, account, { node_key: "b" });
    const inherited = referenceInherit("tool", ["[tool: tool]\nresultado"]);
    expect(composeAgentPrompt(version, { current_node_key: "b", previous_tool_results: [{ node_key: "a", tool_name: "tool", result: "resultado" }] })).toBe("\n\n---\n" + inherited);
  });
  it.each(golden.ddm.filter((c) => !c.hasOverride))("templates globais reais idênticos ao golden: $name ($accountPrompt)", (c) => {
    const context: LegacyDdmContext = { ddm_data: c.ddm_data, found_cpf: c.found_cpf, today_utc: c.today_utc, current_date: c.current_date };
    expect(composeLegacyDdm(c.base, false, c.accountPrompt, context)).toEqual(c.expected);
  });
  it.each(golden.ddm.filter((c) => c.hasOverride))("override não recebe as políticas globais nem perde KB: $name", (c) => {
    const context: LegacyDdmContext = { ddm_data: c.ddm_data, found_cpf: c.found_cpf, today_utc: c.today_utc, current_date: c.current_date };
    expect(composeLegacyDdm(c.base, true, c.accountPrompt, context)).toEqual(c.expected);
    expect(c.expected.systemPrompt).toBe(c.base);
  });
  it("sections_v1 separa persona/regras/KB; desabilitadas não são injetadas", () => {
    const version = { ...convertGlobalResponder(account), composition: "sections_v1" as const, prompt_content: "Você é {{vars.nome}}." };
    expect(composeAgentPrompt(version, { vars: { nome: "Ana" }, kb_files: [{ name: "KB", content: "texto" }], rules: [
      { content: "Regra 2", position: 2, enabled: true }, { content: "omitida", position: 0, enabled: false }, { content: "Regra 1", position: 1, enabled: true },
    ] })).toBe("Você é Ana.\n\n## Regras obrigatórias\n\nRegra 1\n\nRegra 2\n\n## Base de conhecimento\n\n[ARQUIVO: KB]\ntexto\n---");
    expect(() => composeAgentPrompt(convertGlobalResponder(account), { rules: [{ content: "nova", position: 0, enabled: true }] })).toThrow(/sections_v1/);
  });
  it("KB desligada não injeta contexto fornecido pelo loader", () => {
    const version = convertGlobalResponder(account);
    version.config.knowledge.kb_enabled = false;
    expect(composeAgentPrompt(version, { kb_context: "SEGREDO-KB" })).toBe(composeAgentPrompt(version));
    version.composition = "sections_v1";
    expect(composeAgentPrompt(version, { kb_context: "SEGREDO-KB" })).toBe(version.prompt_content);
  });
  it("compositor não faz rede, inclusive com RAG configurado", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const version = convertGlobalResponder(account);
      version.config.knowledge.rag_external = { enabled: true, url: "https://rag.test/retrieve", credential: "{{cred.RAG_TOKEN}}", top_k: 5, timeout_ms: 5000 };
      composeAgentPrompt(version);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});
