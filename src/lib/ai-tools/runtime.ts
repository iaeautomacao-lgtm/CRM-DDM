// Ferramentas EFETIVAS de um nó de IA: catálogo (tool_refs, só habilitadas,
// na ordem dos refs) + inline (legado). Servidor.
//
//  - Sem tool_refs: devolve o inline como está (zero consulta ao banco —
//    nós antigos não mudam).
//  - Ferramenta desligada some da lista enviada ao modelo.
//  - Ref inexistente / de outra conta (a consulta filtra por account_id): ignorado.
//  - Nome duplicado (catálogo × inline ou dois do catálogo): vale a PRIMEIRA
//    (catálogo na ordem dos refs, depois inline) e o resto é logado.

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { toAiAgentTool, type ToolRow } from "@/lib/ai-tools/tool-input";
import type { AiAgentTool } from "@/lib/flows/types";

type CatalogRow = Pick<ToolRow, "id" | "name" | "description" | "parameters" | "http" | "timeout_ms" | "enabled">;

/** Pura: combina catálogo + inline conforme as regras acima. */
export function mergeTools(
  catalog: readonly CatalogRow[],
  refs: readonly string[],
  inline: readonly AiAgentTool[] | undefined,
  onDuplicate: (name: string) => void = () => {},
): AiAgentTool[] {
  const byId = new Map(catalog.map((r) => [r.id, r]));
  const ordered: AiAgentTool[] = [];
  const seen = new Set<string>();
  const push = (tool: AiAgentTool) => {
    if (seen.has(tool.name)) {
      onDuplicate(tool.name);
      return;
    }
    seen.add(tool.name);
    ordered.push(tool);
  };
  for (const id of refs) {
    const row = byId.get(id);
    if (row && row.enabled) push(toAiAgentTool(row));
  }
  for (const tool of inline ?? []) push(tool);
  return ordered;
}

/** Catálogo da conta (id, nome, ligada) para o validador de fluxo. */
export async function listAccountTools(accountId: string): Promise<Array<{ id: string; name: string; enabled: boolean }> | null> {
  const { data, error } = await supabaseAdmin().from("ai_tools").select("id, name, enabled").eq("account_id", accountId);
  // Falha de leitura = não conferir (null), em vez de acusar todas as referências como inexistentes.
  if (error) return null;
  return (data ?? []) as Array<{ id: string; name: string; enabled: boolean }>;
}

export async function resolveEffectiveTools(
  accountId: string,
  inline: AiAgentTool[] | undefined,
  toolRefs: string[] | undefined,
): Promise<AiAgentTool[] | undefined> {
  const refs = Array.isArray(toolRefs) ? toolRefs.filter((r) => typeof r === "string") : [];
  if (refs.length === 0) return inline;
  const { data, error } = await supabaseAdmin()
    .from("ai_tools")
    .select("id, name, description, parameters, http, timeout_ms, enabled")
    .eq("account_id", accountId)
    .in("id", refs);
  if (error) {
    // Não derruba o atendimento: segue só com o inline (o catálogo fica indisponível neste turno).
    console.error("[ai-tools] falha ao carregar o catálogo de ferramentas:", error.message);
    return inline;
  }
  return mergeTools((data ?? []) as CatalogRow[], refs, inline, (name) =>
    console.warn("[ai-tools] nome de ferramenta duplicado no nó; usando a primeira:", name),
  );
}
