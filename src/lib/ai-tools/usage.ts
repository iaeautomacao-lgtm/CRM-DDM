// Em quantos fluxos cada ferramenta do catálogo é usada (config.tool_refs dos
// nós de IA). Servidor; sempre escopado pela conta.

import { supabaseAdmin } from "@/lib/flows/admin-client";

/** Lê todas as linhas por keyset (id > cursor), sem OFFSET. */
async function fetchAllKeyset<Row extends { id: string }>(
  label: string,
  fetchPage: (after: string | null, limit: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<Row[]> {
  const out: Row[] = [];
  let after: string | null = null;
  while (true) {
    const { data, error } = await fetchPage(after, pageSize);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    after = rows[rows.length - 1].id;
  }
  return out;
}

/** flow_id distintos por id de ferramenta. */
export async function loadToolUsage(accountId: string): Promise<Map<string, Set<string>>> {
  const db = supabaseAdmin();
  const flows = await fetchAllKeyset<{ id: string }>("flows", (after, limit) => {
    let q = db.from("flows").select("id").eq("account_id", accountId).order("id").limit(limit);
    if (after != null) q = q.gt("id", after);
    return q;
  });
  const usage = new Map<string, Set<string>>();
  const flowIds = flows.map((f) => f.id);
  // .in() com listas enormes estoura a URL: em blocos de 100 fluxos.
  for (let i = 0; i < flowIds.length; i += 100) {
    const chunk = flowIds.slice(i, i + 100);
    const nodes = await fetchAllKeyset<{ id: string; flow_id: string; config: { tool_refs?: unknown } | null }>(
      "flow_nodes",
      (after, limit) => {
        let q = db
          .from("flow_nodes")
          .select("id, flow_id, config")
          .eq("node_type", "ai_agent")
          .in("flow_id", chunk)
          .order("id")
          .limit(limit);
        if (after != null) q = q.gt("id", after);
        return q;
      },
    );
    for (const node of nodes) {
      const refs = node.config?.tool_refs;
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        if (typeof ref !== "string") continue;
        if (!usage.has(ref)) usage.set(ref, new Set());
        usage.get(ref)!.add(node.flow_id);
      }
    }
  }
  return usage;
}
