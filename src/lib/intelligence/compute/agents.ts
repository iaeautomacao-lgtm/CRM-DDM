// Desempenho por atendente (puro). Usa o assigned_agent_id ATUAL da
// conversa (o histórico de atribuição está em conversation_assignments,
// não usado aqui) — mesma regra do byAgent da aba Hoje do Monitoramento.

import { count, mean, type Stat } from "../stats";
import type { ConversationRow, Period } from "../types";
import { firstResponseMinutes, inPeriod } from "./conversations";

export const NO_AGENT = "none";

export interface AgentStats {
  agent_id: string;
  agent_name: string;
  /** agent_conversations: criadas no período e atribuídas a ele. */
  conversations: Stat;
  /** Finalizadas no período (closed_at) e atribuídas a ele. */
  closed: Stat;
  /** Abertas/pendentes agora (independe do período). */
  open_now: Stat;
  /** agent_first_response_avg_min. */
  first_response_avg_min: Stat;
}

export function computeAgentPerformance(
  periodRows: ConversationRow[],
  openNowRows: Array<Pick<ConversationRow, "assigned_agent_id" | "status">>,
  period: Period,
  agentNames: Map<string, string> = new Map(),
): AgentStats[] {
  const keyOf = (id: string | null) => id ?? NO_AGENT;
  const agents = new Set<string>();
  for (const r of periodRows) agents.add(keyOf(r.assigned_agent_id));
  for (const r of openNowRows) if (r.status !== "closed") agents.add(keyOf(r.assigned_agent_id));

  return [...agents]
    .map((agent) => {
      const mine = periodRows.filter((r) => keyOf(r.assigned_agent_id) === agent);
      const mins = mine
        .filter((r) => inPeriod(r.first_response_at, period))
        .map((r) => firstResponseMinutes(r) as number);
      return {
        agent_id: agent,
        agent_name: agent === NO_AGENT ? "Sem atendente" : agentNames.get(agent) ?? agent,
        conversations: count(mine.filter((r) => inPeriod(r.created_at, period)).length),
        closed: count(mine.filter((r) => inPeriod(r.closed_at, period)).length),
        open_now: count(
          openNowRows.filter((r) => r.status !== "closed" && keyOf(r.assigned_agent_id) === agent).length,
        ),
        first_response_avg_min: mean(mins, 1),
      };
    })
    .filter((a) => (a.conversations.value ?? 0) + (a.closed.value ?? 0) + (a.open_now.value ?? 0) + a.first_response_avg_min.denominator > 0)
    .sort(
      (a, b) =>
        (b.conversations.value ?? 0) - (a.conversations.value ?? 0) ||
        (b.closed.value ?? 0) - (a.closed.value ?? 0) ||
        a.agent_name.localeCompare(b.agent_name),
    );
}
