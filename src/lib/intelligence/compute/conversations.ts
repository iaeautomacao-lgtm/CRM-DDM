// Métricas de conversa (puro). Definições em metrics/registry.ts —
// alinhadas com monitoramento/day-view.ts (recebidas por created_at,
// atendidas por first_response_at, finalizadas por closed_at).

import { count, mean, percentile, type Stat } from "../stats";
import type { ConversationRow, Period } from "../types";

export function inPeriod(iso: string | null | undefined, period: Pick<Period, "from" | "to">): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= Date.parse(period.from) && t < Date.parse(period.to);
}

/** Minutos até a 1ª resposta humana (nunca negativo). */
export function firstResponseMinutes(row: Pick<ConversationRow, "created_at" | "first_response_at">): number | null {
  if (!row.first_response_at) return null;
  return Math.max(0, (Date.parse(row.first_response_at) - Date.parse(row.created_at)) / 60_000);
}

export interface ConversationMetrics {
  conversations_total: Stat;
  conversations_open: Stat;
  conversations_pending: Stat;
  conversations_closed: Stat;
  first_response_avg_min: Stat;
  first_response_p90_min: Stat;
}

export function computeConversationMetrics(rows: ConversationRow[], period: Period): ConversationMetrics {
  const created = rows.filter((r) => inPeriod(r.created_at, period));
  const responseMins = rows
    .filter((r) => inPeriod(r.first_response_at, period))
    .map((r) => firstResponseMinutes(r) as number);
  return {
    conversations_total: count(created.length),
    conversations_open: count(created.filter((r) => r.status === "open").length),
    conversations_pending: count(created.filter((r) => r.status === "pending").length),
    conversations_closed: count(rows.filter((r) => inPeriod(r.closed_at, period)).length),
    first_response_avg_min: mean(responseMins, 1),
    first_response_p90_min: percentile(responseMins, 90, 1),
  };
}
