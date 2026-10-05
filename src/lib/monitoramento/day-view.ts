// Visão do dia do Monitoramento (aba "Hoje"). Puro — a rota
// /api/monitoramento/dia busca as conversas que tocam o dia e este módulo
// agrega. O dia é o calendário de Brasília (UTC-3, sem horário de verão
// desde 2019).
//
//   recebidas   conversas criadas no dia
//   atendidas   1ª resposta humana no dia (first_response_at, migration 128)
//   finalizadas fechadas no dia (closed_at, migration 130)
//   em aberto   abertas/pendentes agora (só quando o dia é hoje)

export const DAY_TZ_OFFSET = "-03:00";
const OFFSET_MS = -3 * 3_600_000;

export interface DayConversationRow {
  channel_type: string | null;
  team_id: string | null;
  assigned_agent_id: string | null;
  status: "open" | "pending" | "closed";
  created_at: string;
  first_response_at: string | null;
  closed_at: string | null;
}

export interface DayStats {
  key: string;
  received: number;
  attended: number;
  closed: number;
  open: number;
  /** Média da 1ª resposta das atendidas no dia, em minutos. */
  firstResponseAvgMin: number | null;
}

export interface DayView {
  date: string;
  total: DayStats;
  /** Recebidas por hora (0–23, horário de Brasília). */
  hourly: number[];
  byAgent: DayStats[];
  byTeam: DayStats[];
  byChannel: DayStats[];
}

/** Data de hoje (YYYY-MM-DD) em Brasília. */
export function todayInBrazil(nowMs = Date.now()): string {
  return new Date(nowMs + OFFSET_MS).toISOString().slice(0, 10);
}

/** Início e fim (exclusivo) do dia em Brasília, em ms UTC. */
export function dayBounds(date: string): { startMs: number; endMs: number } {
  const startMs = Date.parse(`${date}T00:00:00${DAY_TZ_OFFSET}`);
  return { startMs, endMs: startMs + 86_400_000 };
}

export function isValidDay(date: string | null): date is string {
  return !!date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`));
}

function aggregate(key: string, rows: DayConversationRow[], b: { startMs: number; endMs: number }, isToday: boolean): DayStats {
  const inDay = (iso: string | null) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return t >= b.startMs && t < b.endMs;
  };
  const attended = rows.filter((r) => inDay(r.first_response_at));
  const mins = attended.map((r) =>
    Math.max(0, (Date.parse(r.first_response_at as string) - Date.parse(r.created_at)) / 60_000)
  );
  return {
    key,
    received: rows.filter((r) => inDay(r.created_at)).length,
    attended: attended.length,
    closed: rows.filter((r) => inDay(r.closed_at)).length,
    open: isToday ? rows.filter((r) => r.status !== "closed").length : 0,
    firstResponseAvgMin: mins.length ? Math.round((mins.reduce((a, c) => a + c, 0) / mins.length) * 10) / 10 : null,
  };
}

export function computeDayView(rows: DayConversationRow[], date: string, isToday: boolean): DayView {
  const b = dayBounds(date);
  const hourly = Array.from({ length: 24 }, () => 0);
  for (const r of rows) {
    const t = Date.parse(r.created_at);
    if (t >= b.startMs && t < b.endMs) hourly[Math.floor((t - b.startMs) / 3_600_000)]++;
  }
  const group = (keyOf: (r: DayConversationRow) => string) => {
    const map = new Map<string, DayConversationRow[]>();
    for (const r of rows) {
      const k = keyOf(r);
      const list = map.get(k);
      if (list) list.push(r);
      else map.set(k, [r]);
    }
    return [...map.entries()]
      .map(([k, list]) => aggregate(k, list, b, isToday))
      .filter((s) => s.received + s.attended + s.closed + s.open > 0)
      .sort((x, y) => y.attended + y.closed - (x.attended + x.closed) || y.received - x.received);
  };
  return {
    date,
    total: aggregate("all", rows, b, isToday),
    hourly,
    byAgent: group((r) => r.assigned_agent_id ?? "none"),
    byTeam: group((r) => r.team_id ?? "none"),
    byChannel: group((r) => r.channel_type ?? "whatsapp"),
  };
}
