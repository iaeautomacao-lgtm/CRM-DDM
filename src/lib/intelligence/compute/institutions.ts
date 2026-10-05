// Comparação por instituição = Cliente de /canais (wacrm.clients via
// conversations.client_id). Conversas sem cliente caem em "Sem cliente".
// As métricas de IA usam o client_id da conversa de cada execução.

import { count, mean, percentile, ratio, type Stat } from "../stats";
import type { ConversationRow, Period } from "../types";
import { firstResponseMinutes, inPeriod } from "./conversations";
import type { RunFacts } from "./runs";

export const NO_CLIENT = "none";

export interface InstitutionStats {
  client_id: string;
  client_name: string;
  conversations_total: Stat;
  conversations_closed: Stat;
  /** Das criadas no período, abertas/pendentes agora. */
  conversations_open_or_pending: Stat;
  first_response_avg_min: Stat;
  first_response_p90_min: Stat;
  ai_runs_finished: Stat;
  ai_handoff_rate: Stat;
  ai_containment_rate: Stat;
}

export function computeInstitutions(
  rows: ConversationRow[],
  facts: RunFacts[],
  /** conversation_id → client_id (das conversas das execuções). */
  runConversationClient: Map<string, string | null>,
  period: Period,
  clientNames: Map<string, string> = new Map(),
): InstitutionStats[] {
  const keyOf = (id: string | null | undefined) => id ?? NO_CLIENT;
  const clients = new Set<string>(rows.map((r) => keyOf(r.client_id)));
  const aiFinished = facts.filter((f) => f.isAi && f.finished);
  const runClient = (f: RunFacts) =>
    keyOf(f.run.conversation_id ? runConversationClient.get(f.run.conversation_id) : null);
  for (const f of aiFinished) clients.add(runClient(f));

  return [...clients]
    .map((c) => {
      const mine = rows.filter((r) => keyOf(r.client_id) === c);
      const created = mine.filter((r) => inPeriod(r.created_at, period));
      const mins = mine
        .filter((r) => inPeriod(r.first_response_at, period))
        .map((r) => firstResponseMinutes(r) as number);
      const ai = aiFinished.filter((f) => runClient(f) === c);
      return {
        client_id: c,
        client_name: c === NO_CLIENT ? "Sem cliente" : clientNames.get(c) ?? c,
        conversations_total: count(created.length),
        conversations_closed: count(mine.filter((r) => inPeriod(r.closed_at, period)).length),
        conversations_open_or_pending: count(created.filter((r) => r.status !== "closed").length),
        first_response_avg_min: mean(mins, 1),
        first_response_p90_min: percentile(mins, 90, 1),
        ai_runs_finished: count(ai.length),
        ai_handoff_rate: ratio(ai.filter((f) => f.outcome === "human_handoff").length, ai.length),
        ai_containment_rate: ratio(ai.filter((f) => f.outcome === "contained").length, ai.length),
      };
    })
    .sort(
      (a, b) =>
        (b.conversations_total.value ?? 0) - (a.conversations_total.value ?? 0) ||
        a.client_name.localeCompare(b.client_name),
    );
}
