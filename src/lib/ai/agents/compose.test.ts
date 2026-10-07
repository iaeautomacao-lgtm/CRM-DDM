import { readFileSync } from "node:fs";
import { transpile, ScriptTarget } from "typescript";
import { describe, expect, it, vi } from "vitest";
import { composeAgentPrompt } from "./compose";
import { composeLegacyDdm, type LegacyDdmContext } from "./legacy-compose";
import { convertAiAgentNode, convertGlobalResponder } from "./convert";
import { buildKnowledgeBaseContext } from "../kb-context";

const account = { account_id: "00000000-0000-0000-0000-00000000000a", enabled: true, api_provider: "openai", system_prompt: "Prompt global" };
const responder = readFileSync("src/lib/ai/responder.ts", "utf8");
const engine = readFileSync("src/lib/flows/engine.ts", "utf8");
const routingFixture = readFileSync("src/lib/flows/exit-tag-routing.test.ts", "utf8");
const officialPrompts = ["AGENTE_DDM_PROMPT", "RECOVERY_PROMPT"].map((name) => {
  const match = routingFixture.match(new RegExp("const " + name + " = `([\\s\\S]*?)`;"));
  if (!match) throw new Error(`Fixture oficial ${name} ausente.`);
  return match[1];
});

// Oracle é a projeção pura do código ATUAL, não outra cópia do módulo novo.
// Não importa/evalua o responder inteiro e não executa DB, rede ou side effects.
const ddmStart = responder.indexOf("  if (ddmData) {", responder.indexOf("let forceTransferHumanMsg"));
const ddmEnd = responder.indexOf("  // 5. Generate response", ddmStart);
const ddmBody = responder.slice(ddmStart, ddmEnd)
  .replace('new Date().toISOString().split("T")[0]', "todayUtc")
  .replace('new Date().toLocaleDateString("pt-BR")', "inputDate");
const referenceDdm = new Function("base", "hasOverride", "accountPrompt", "ddmData", "foundCpf", "todayUtc", "inputDate",
  transpile(`let systemPromptWithKb=base; let forceTransferHumanMsg=""; const aiConfig={system_prompt:accountPrompt}; ${ddmBody}
    return {systemPrompt:systemPromptWithKb,forcedReply:forceTransferHumanMsg};`, { target: ScriptTarget.ES2022 })) as
  (base: string, override: boolean, prompt: string, data: LegacyDdmContext["ddm_data"], cpf?: string | null, utc?: string, date?: string) => { systemPrompt: string; forcedReply: string };
const kbTemplateStart = responder.indexOf("    systemPromptWithKb = ", responder.indexOf("const kbContext = buildKnowledgeBaseContext"));
const kbTemplateEnd = responder.indexOf(";", kbTemplateStart);
const referenceKb = new Function("systemPromptWithKb", "kbContext", responder.slice(kbTemplateStart, kbTemplateEnd + 1) + "return systemPromptWithKb;") as (base: string, kb: string) => string;
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
      expect(composeAgentPrompt(version)).toBe(referenceDdm(account.system_prompt, false, account.system_prompt, null).systemPrompt);
    }
  });
  it("fallback interno/global e herança sem override conservam a semântica legada", () => {
    const global = convertGlobalResponder({ ...account, system_prompt: "" });
    expect(composeAgentPrompt(global)).toBe(referenceDdm("Você é um assistente virtual. Aguarde um momento.", false, "", null).systemPrompt);
    const version = convertAiAgentNode({ mode: "loop", herdar_contexto_anterior: true }, account, { node_key: "b" });
    const inherited = referenceInherit("tool", ["[tool: tool]\nresultado"]);
    expect(composeAgentPrompt(version, { current_node_key: "b", previous_tool_results: [{ node_key: "a", tool_name: "tool", result: "resultado" }] })).toBe("\n\n---\n" + inherited);
  });
  it.each([
    { ddm_data: { instituicao: "Cruzeiro", valor_divida: "100,00", nome: "José" }, found_cpf: "123" },
    { ddm_data: { instituicao: "UVA", valor_divida: "100,00", resumo_parcelamento: [], acordos: [] }, found_cpf: "123", today_utc: "2026-10-07", current_date: "07/10/2026" },
    { ddm_data: { instituicao: "UVA", valor_divida: 0, acordos: [{ status: "ativo" }] }, today_utc: "2026-10-07", current_date: "07/10/2026" },
    { ddm_data: { instituicao: "Outra", valor_divida: "200,00" } },
    { ddm_data: { instituicao: "Outra", valor_divida: "0,00" } },
    { found_cpf: "123", ddm_data: null },
  ] satisfies LegacyDdmContext[])("templates globais reais equivalentes: %j", (context) => {
    const expected = referenceDdm("base KB", false, account.system_prompt, context.ddm_data, context.found_cpf, "today_utc" in context ? context.today_utc : undefined, "current_date" in context ? context.current_date : undefined);
    expect(composeLegacyDdm("base KB", false, account.system_prompt, context)).toEqual(expected);
    // Override não recebe essas políticas globais nem perde KB.
    expect(composeLegacyDdm("nó + KB", true, account.system_prompt, context).systemPrompt).toBe("nó + KB");
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
