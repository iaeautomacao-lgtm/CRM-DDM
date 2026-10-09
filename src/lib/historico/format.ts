export type HistoryPeriod = "hoje" | "7d" | "30d" | "todas";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Início do período (ISO) para filtrar por data de encerramento; null = sem limite. */
export function periodStartIso(period: HistoryPeriod, now: Date = new Date()): string | null {
  if (period === "todas") return null;
  if (period === "hoje") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }
  return new Date(now.getTime() - (period === "7d" ? 7 : 30) * DAY_MS).toISOString();
}

/** Duração entre abertura e encerramento ("12 min", "3 h 05 min", "2 d 4 h"); null se faltar uma das datas ou ficar negativa. */
export function formatDuration(startIso: string | null | undefined, endIso: string | null | undefined): string | null {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60000);
  if (min < 1) return "< 1 min";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${String(min % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
