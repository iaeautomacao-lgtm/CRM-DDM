import { supabaseAdmin } from "@/lib/flows/admin-client";
import type { RequestedAgent } from "@/types";

export type { RequestedAgent };

// "Aguardando @fulano" no Inbox (migration 376): para quem a conversa está reservada. Só os três campos de RequestedAgent saem;
// nada do contato nem do perfil além disso (sem e-mail, papel ou telefone).

type ProfileRow = { user_id: string; full_name: string | null; mention_alias?: string | null };

/**
 * Perfis dos operadores reservados, sempre filtrados pela conta (o id sozinho nunca basta). Chamar só com ids de conversas que
 * o usuário JÁ leu com a sessão dele: a RLS (policies da 376) decide quem vê a reserva; aqui só se resolve o nome.
 * Tolerante: sem a coluna mention_alias refaz sem ela; qualquer outro erro devolve vazio (a conversa segue com requested_agent_id,
 * só sem o nome).
 */
export async function loadRequestedAgents(accountId: string, ids: readonly string[]): Promise<Map<string, RequestedAgent>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, RequestedAgent>();
  if (unique.length === 0) return out;
  try {
    const db = supabaseAdmin();
    const load = (columns: string) => db.from("profiles").select(columns).eq("account_id", accountId).in("user_id", unique);
    let { data, error } = await load("user_id, full_name, mention_alias");
    if (error && (error.code === "42703" || error.code === "PGRST204")) ({ data, error } = await load("user_id, full_name"));
    if (error) return out;
    for (const p of (data ?? []) as unknown as ProfileRow[]) {
      out.set(p.user_id, { user_id: p.user_id, full_name: p.full_name ?? null, mention_alias: p.mention_alias ?? null });
    }
  } catch {
    // sem o nome: a tela cai no texto genérico
  }
  return out;
}

/** Acrescenta `requested_agent` (RequestedAgent | null) a cada conversa da lista. Sem reserva: null. */
export async function attachRequestedAgents<T extends { requested_agent_id?: string | null }>(
  accountId: string,
  rows: readonly T[],
): Promise<Array<T & { requested_agent: RequestedAgent | null }>> {
  const agents = await loadRequestedAgents(accountId, rows.map((r) => r.requested_agent_id ?? "").filter(Boolean));
  return rows.map((r) => ({ ...r, requested_agent: r.requested_agent_id ? (agents.get(r.requested_agent_id) ?? null) : null }));
}
