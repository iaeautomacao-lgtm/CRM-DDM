/* eslint-disable @typescript-eslint/no-explicit-any -- cliente admin com schema wacrm */
// Transferência da conversa para a FILA DA EQUIPE feita pelas travas do
// responder (anti-abuso e anti-loop), antes de chamar o modelo. Mesma regra
// do nó handoff_team: status "pending", atendente escolhido na equipe da
// conversa (ou qualquer atendente da conta) — nunca mais o dono da
// conversa/do número, como as travas faziam antes.

import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient<any, any, any>;

export type TeamQueueHandoff =
  | { ok: true; teamId: string | null; assignedTo: string | null }
  | { ok: false; error: string };

/**
 * Põe a conversa na fila humana. `ok: true` só depois que a conversa foi
 * gravada — sem isso o Flow Engine encerraria o run como handed_off com a
 * conversa fora da fila.
 */
export async function handOffToTeamQueue(
  db: Db,
  accountId: string,
  conversationId: string,
  logPrefix: string,
): Promise<TeamQueueHandoff> {
  const { data: convRows } = await db
    .from("conversations")
    .select("team_id")
    .eq("id", conversationId)
    .limit(1);
  const teamId = (convRows?.[0] as { team_id?: string | null } | undefined)?.team_id ?? null;

  // Import dinâmico: engine.ts importa o responder (evita ciclo no load).
  const { selectAgentForTeam, selectAnyAgentForAccount } = await import("@/lib/flows/engine");
  const engineDb = db as unknown as Parameters<typeof selectAgentForTeam>[0];
  let assignedTo: string | null = null;
  try {
    assignedTo = teamId
      ? await selectAgentForTeam(engineDb, teamId, accountId)
      : await selectAnyAgentForAccount(engineDb, accountId);
  } catch (err) {
    // Sem atendente escolhido a conversa fica na fila (pending, sem dono).
    console.error(`${logPrefix}: falha ao escolher atendente:`, err);
  }

  const { error } = await db
    .from("conversations")
    .update({
      status: "pending",
      assigned_agent_id: assignedTo,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, teamId, assignedTo };
}
