// SLA do atendimento (F6), por canal e por equipe. Puro — a rota
// /api/monitoramento/sla busca as conversas e este módulo agrega.
//
// Fontes (migration 128):
//   first_response_at        1ª mensagem de atendente humano na conversa
//   last_customer_message_at última mensagem do cliente
// "Na fila" = conversa aberta/pendente sem atendente; a espera conta da
// última mensagem do cliente.

export interface SlaConversationRow {
  channel_type: string | null;
  team_id: string | null;
  status: "open" | "pending" | "closed";
  assigned_agent_id: string | null;
  created_at: string;
  first_response_at: string | null;
  last_customer_message_at: string | null;
}

export interface SlaStats {
  key: string;
  /** Conversas criadas no período. */
  created: number;
  /** Delas, quantas já tiveram resposta humana. */
  responded: number;
  /** Primeira resposta: média e p90, em minutos (null sem amostra). */
  firstResponseAvgMin: number | null;
  firstResponseP90Min: number | null;
  /** % respondidas dentro da meta (das que tiveram resposta). */
  withinTargetPct: number | null;
  /** Agora: na fila sem atendente e a maior espera (minutos). */
  queued: number;
  longestWaitMin: number | null;
}

export const SLA_TARGET_MINUTES = 15;

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function aggregate(key: string, rows: SlaConversationRow[], sinceMs: number, nowMs: number): SlaStats {
  const inPeriod = rows.filter((r) => Date.parse(r.created_at) >= sinceMs);
  const responseMins = inPeriod
    .filter((r) => r.first_response_at)
    .map((r) => Math.max(0, (Date.parse(r.first_response_at as string) - Date.parse(r.created_at)) / 60_000))
    .sort((a, b) => a - b);
  const queued = rows.filter((r) => r.status !== "closed" && !r.assigned_agent_id);
  const waits = queued
    .filter((r) => r.last_customer_message_at)
    .map((r) => (nowMs - Date.parse(r.last_customer_message_at as string)) / 60_000);

  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    key,
    created: inPeriod.length,
    responded: responseMins.length,
    firstResponseAvgMin: responseMins.length
      ? round(responseMins.reduce((a, b) => a + b, 0) / responseMins.length)
      : null,
    firstResponseP90Min: responseMins.length ? round(percentile(responseMins, 90)) : null,
    withinTargetPct: responseMins.length
      ? Math.round((responseMins.filter((m) => m <= SLA_TARGET_MINUTES).length / responseMins.length) * 100)
      : null,
    queued: queued.length,
    longestWaitMin: waits.length ? Math.round(Math.max(...waits)) : null,
  };
}

/** Agrupa por canal e por equipe (chave "none" = sem equipe). */
export function computeSla(
  rows: SlaConversationRow[],
  opts: { sinceMs: number; nowMs: number },
): { total: SlaStats; byChannel: SlaStats[]; byTeam: SlaStats[] } {
  const group = (keyOf: (r: SlaConversationRow) => string) => {
    const map = new Map<string, SlaConversationRow[]>();
    for (const r of rows) {
      const k = keyOf(r);
      const list = map.get(k);
      if (list) list.push(r);
      else map.set(k, [r]);
    }
    return [...map.entries()]
      .map(([k, list]) => aggregate(k, list, opts.sinceMs, opts.nowMs))
      .sort((a, b) => b.created - a.created || b.queued - a.queued);
  };
  return {
    total: aggregate("all", rows, opts.sinceMs, opts.nowMs),
    byChannel: group((r) => r.channel_type ?? "whatsapp"),
    byTeam: group((r) => r.team_id ?? "none"),
  };
}
