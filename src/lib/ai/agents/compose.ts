import { buildKnowledgeBaseContext, type KbFile } from "../kb-context";
import { composeLegacyDdm, type LegacyDdmContext } from "./legacy-compose";
import { LEGACY_AGENT_DEFAULTS, type AgentPromptVersion, type AgentRule } from "./schema";

export interface PromptContext extends LegacyDdmContext {
  vars?: Record<string, unknown>;
  kb_files?: KbFile[];
  recent_customer_text?: string;
  // Um loader futuro pode fornecer contexto já ranqueado conforme a policy do perfil.
  kb_context?: string;
  current_node_key?: string;
  previous_tool_results?: { node_key: string | null; tool_name?: string; result?: string }[];
  rules?: AgentRule[];
}

function interpolateVars(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function inheritedContext(version: AgentPromptVersion, context: PromptContext): string {
  if (!version.config.behavior.herdar_contexto) return "";
  if (!context.current_node_key && context.previous_tool_results?.length) {
    throw new Error("Herança exige o node_key real do binding.");
  }
  const names = new Set<string>();
  const limit = version.config.execution.inherit_result_chars ?? LEGACY_AGENT_DEFAULTS.execution.inherit_result_chars;
  const blocks = (context.previous_tool_results ?? [])
    .filter((event) => event.node_key !== context.current_node_key)
    .flatMap((event) => {
      if (!event.tool_name || !event.result) return [];
      names.add(event.tool_name);
      const result = event.result.length > limit ? event.result.slice(0, limit) + "…" : event.result;
      return [`[tool: ${event.tool_name}]\n${result}`];
    });
  if (!blocks.length) return "";
  // Espelho byte a byte de engine.ts:2382; não altera o engine ou sua truncagem.
  return "## DADOS JÁ OBTIDOS — NÃO CHAME AS FERRAMENTAS NOVAMENTE\n\n"
    + "As ferramentas abaixo já foram executadas nesta conversa. "
    + `Use exclusivamente estes dados. NÃO chame ${[...names].join(", ")} novamente:\n\n`
    + blocks.join("\n")
    + "\n\nREGRA ABSOLUTA: Com estes dados disponíveis, prossiga diretamente "
    + "para a próxima fase sem chamar nenhuma ferramenta de consulta.";
}

/** Pura: recebe dados/KB/datas. Nunca resolve credenciais nem chama RAG, tools ou LLM. */
export function composeAgentPrompt(version: AgentPromptVersion, context: PromptContext = {}): string {
  const { config } = version;
  const kbEnabled = config.knowledge.kb_enabled ?? LEGACY_AGENT_DEFAULTS.knowledge.kb_enabled;
  const kbFiles = kbEnabled ? (context.kb_files ?? []) : [];
  const kb = kbEnabled ? (context.kb_context ?? buildKnowledgeBaseContext(
    kbFiles, context.recent_customer_text ?? "", config.knowledge.max_chars ?? LEGACY_AGENT_DEFAULTS.knowledge.max_chars,
  )) : "";
  const inherit = inheritedContext(version, context);
  if (version.composition === "legacy_v1") {
    if (context.rules?.some((rule) => rule.enabled)) throw new Error("legacy_v1 mantém rules=[]; publique sections_v1 para adicionar regras.");
    let override = config.prompt.legacy_override_present ? interpolateVars(version.prompt_content, context.vars ?? {}) : "";
    if (inherit) override += "\n\n---\n" + inherit;
    const hasOverride = override.trim() !== "";
    let prompt = hasOverride ? override : (config.prompt.account_content ? config.prompt.account_content : LEGACY_AGENT_DEFAULTS.fallback_prompt);
    // No legado, até uma lista cujo contexto final é vazio gera os delimitadores.
    if (kbEnabled && (kbFiles.length || context.kb_context !== undefined)) prompt += `

=== BASE DE CONHECIMENTO DISPONÍVEL ===
${kb}
=== FIM DA BASE DE CONHECIMENTO ===

Use as informações da base de conhecimento acima para responder às dúvidas do cliente com a maior precisão possível. Se a informação não estiver na base, aja de acordo com suas instruções normais.`;
    return composeLegacyDdm(prompt, hasOverride, config.prompt.account_content, context).systemPrompt;
  }
  const rules = [...(context.rules ?? [])].filter((r) => r.enabled).sort((a, b) => a.position - b.position);
  if (new Set(rules.map((r) => r.position)).size !== rules.length) throw new Error("Posições de regras devem ser únicas.");
  const blocks = [interpolateVars(version.prompt_content, context.vars ?? {})];
  if (rules.length) blocks.push("## Regras obrigatórias\n\n" + rules.map((r) => r.content).join("\n\n"));
  if (inherit) blocks.push(inherit);
  if (kb) blocks.push("## Base de conhecimento\n\n" + kb);
  // rag_external é apenas contrato/config nesta fase; nenhum fetch nem bloco de retorno implícito.
  return blocks.join("\n\n");
}
