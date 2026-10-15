// Pausas de atendimento — parte PURA (sem banco): validação dos motivos, visão da pausa e relatório por atendente.
// Contrato com o front: prd-v2/pausas-contrato-api.md. Nada aqui lê relógio: `now` é sempre passado (testável).

export const REASON_NAME_MAX = 40;
export const REASON_MAX_MINUTES = 1440;
export const REPORT_MAX_DAYS = 92;
export const REPORT_DEFAULT_LIMIT = 100;
export const REPORT_MAX_LIMIT = 500;

export class PauseApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PauseApiError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

const invalid = (message: string) => new PauseApiError("invalid_reason", message, 400);

function parseName(raw: unknown): string {
  if (typeof raw !== "string") throw invalid("Informe o nome do motivo");
  const name = raw.trim();
  if (name.length < 1 || name.length > REASON_NAME_MAX) throw invalid(`O nome do motivo deve ter de 1 a ${REASON_NAME_MAX} caracteres`);
  return name;
}

function parseMaxMinutes(raw: unknown): number | null {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > REASON_MAX_MINUTES) {
    throw invalid(`O tempo máximo deve ser um número inteiro de minutos entre 1 e ${REASON_MAX_MINUTES} (ou vazio para sem limite)`);
  }
  return raw;
}

export interface ReasonCreate {
  name: string;
  max_minutes: number | null;
}

export function parseReasonCreate(body: unknown): ReasonCreate {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PauseApiError("invalid_request", "Corpo inválido", 400);
  const b = body as Record<string, unknown>;
  return { name: parseName(b.name), max_minutes: b.max_minutes === undefined ? null : parseMaxMinutes(b.max_minutes) };
}

export interface ReasonPatch {
  name?: string;
  max_minutes?: number | null;
  active?: boolean;
  sort_order?: number;
}

export function parseReasonPatch(body: unknown): ReasonPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PauseApiError("invalid_request", "Corpo inválido", 400);
  const b = body as Record<string, unknown>;
  const out: ReasonPatch = {};
  if (b.name !== undefined) out.name = parseName(b.name);
  if (b.max_minutes !== undefined) out.max_minutes = parseMaxMinutes(b.max_minutes);
  if (b.active !== undefined) {
    if (typeof b.active !== "boolean") throw invalid("`active` deve ser verdadeiro ou falso");
    out.active = b.active;
  }
  if (b.sort_order !== undefined) {
    if (typeof b.sort_order !== "number" || !Number.isInteger(b.sort_order) || b.sort_order < 0 || b.sort_order > 100000) throw invalid("`sort_order` inválido");
    out.sort_order = b.sort_order;
  }
  if (Object.keys(out).length === 0) throw invalid("Informe ao menos um campo: name, max_minutes, active ou sort_order");
  return out;
}

// ── Visão da pausa ───────────────────────────────────────────────────────────

export interface PauseRow {
  id: string;
  user_id: string;
  reason_id: string | null;
  reason_name: string;
  max_minutes: number | null;
  started_at: string;
  ended_at: string | null;
  end_kind: "manual" | "supervisor" | "desconexao" | null;
  started_by: string | null;
  ended_by: string | null;
  alerted_at: string | null;
}

export interface PauseView extends PauseRow {
  user_name: string | null;
  started_by_name: string | null;
  by_supervisor: boolean;
  elapsed_seconds: number;
  exceeded: boolean;
}

export const PAUSE_COLUMNS = "id, user_id, reason_id, reason_name, max_minutes, started_at, ended_at, end_kind, started_by, ended_by, alerted_at";

const ms = (iso: string) => new Date(iso).getTime();

/** Segundos da pausa até `ended_at` (ou até agora, se aberta). */
export function pauseSeconds(row: Pick<PauseRow, "started_at" | "ended_at">, now: number): number {
  const end = row.ended_at ? ms(row.ended_at) : now;
  return Math.max(0, Math.round((end - ms(row.started_at)) / 1000));
}

export function toPauseView(row: PauseRow, names: ReadonlyMap<string, string>, now: number): PauseView {
  const elapsed = pauseSeconds(row, now);
  return {
    ...row,
    user_name: names.get(row.user_id) ?? null,
    started_by_name: row.started_by ? (names.get(row.started_by) ?? null) : null,
    by_supervisor: row.started_by !== null && row.started_by !== row.user_id,
    elapsed_seconds: elapsed,
    exceeded: row.max_minutes !== null && elapsed > row.max_minutes * 60,
  };
}

// ── Relatório ────────────────────────────────────────────────────────────────

/** Dia civil de Brasília (UTC-3 fixo) → instante inicial. */
const dayStartMs = (day: string) => Date.parse(`${day}T00:00:00-03:00`);

export interface ReportPeriod {
  from: string;
  to: string;
  fromMs: number;
  /** Exclusivo (início do dia seguinte ao `to`). */
  toMs: number;
}

export function parseReportPeriod(from: string | null, to: string | null, now: number): ReportPeriod {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date(now - 3 * 3_600_000).toISOString().slice(0, 10);
  const toDay = to ?? today;
  const fromDay = from ?? new Date(dayStartMs(toDay) - 6 * 86_400_000 + 3 * 3_600_000).toISOString().slice(0, 10);
  if (!day.test(fromDay) || !day.test(toDay) || Number.isNaN(dayStartMs(fromDay)) || Number.isNaN(dayStartMs(toDay))) {
    throw new PauseApiError("invalid_period", "Use datas no formato AAAA-MM-DD em `de` e `ate`", 400);
  }
  const fromMs = dayStartMs(fromDay);
  const toMs = dayStartMs(toDay) + 86_400_000;
  if (toMs <= fromMs) throw new PauseApiError("invalid_period", "`ate` deve ser igual ou posterior a `de`", 400);
  if (toMs - fromMs > REPORT_MAX_DAYS * 86_400_000) throw new PauseApiError("invalid_period", `Período máximo de ${REPORT_MAX_DAYS} dias`, 400);
  return { from: fromDay, to: toDay, fromMs, toMs };
}

/** Segundos de [a,b) que caem dentro de [from,to). */
export const overlapSeconds = (aMs: number, bMs: number, fromMs: number, toMs: number): number =>
  Math.max(0, Math.round((Math.min(bMs, toMs) - Math.max(aMs, fromMs)) / 1000));

export interface SessionRow {
  user_id: string;
  logged_in_at: string;
  logged_out_at: string | null;
}

export interface AgentReportReason {
  reason_name: string;
  pauses: number;
  total_seconds: number;
  exceeded_count: number;
}

export interface AgentReport {
  user_id: string;
  name: string | null;
  pauses: number;
  total_seconds: number;
  avg_seconds: number;
  longest_seconds: number;
  exceeded_count: number;
  open_count: number;
  by_reason: AgentReportReason[];
  logged_seconds: number | null;
  pct_of_logged: number | null;
}

/**
 * Agrega as pausas por atendente. A pausa que cruza o período entra RECORTADA ao período; a aberta conta até agora. "Estourou" = a pausa
 * INTEIRA passou do limite gravado nela (não só o pedaço dentro do período). `pct_of_logged` = tempo em pausa ÷ tempo logado (agent_sessions)
 * dentro do período; null quando não há sessão registrada.
 */
export function buildAgentReport(
  pauses: readonly PauseRow[],
  sessions: readonly SessionRow[],
  names: ReadonlyMap<string, string>,
  period: Pick<ReportPeriod, "fromMs" | "toMs">,
  now: number,
): AgentReport[] {
  const loggedByUser = new Map<string, number>();
  for (const s of sessions) {
    const end = s.logged_out_at ? ms(s.logged_out_at) : now;
    const secs = overlapSeconds(ms(s.logged_in_at), end, period.fromMs, period.toMs);
    loggedByUser.set(s.user_id, (loggedByUser.get(s.user_id) ?? 0) + secs);
  }

  const byUser = new Map<string, { rows: Array<{ clipped: number; exceeded: boolean; reason: string; open: boolean }> }>();
  for (const p of pauses) {
    const end = p.ended_at ? ms(p.ended_at) : now;
    const clipped = overlapSeconds(ms(p.started_at), end, period.fromMs, period.toMs);
    if (end <= period.fromMs || ms(p.started_at) >= period.toMs) continue;
    const full = pauseSeconds(p, now);
    const entry = byUser.get(p.user_id) ?? { rows: [] };
    entry.rows.push({ clipped, exceeded: p.max_minutes !== null && full > p.max_minutes * 60, reason: p.reason_name, open: p.ended_at === null });
    byUser.set(p.user_id, entry);
  }

  const out: AgentReport[] = [];
  for (const [userId, { rows }] of byUser) {
    const total = rows.reduce((s, r) => s + r.clipped, 0);
    const reasons = new Map<string, AgentReportReason>();
    for (const r of rows) {
      const cur = reasons.get(r.reason) ?? { reason_name: r.reason, pauses: 0, total_seconds: 0, exceeded_count: 0 };
      cur.pauses += 1;
      cur.total_seconds += r.clipped;
      if (r.exceeded) cur.exceeded_count += 1;
      reasons.set(r.reason, cur);
    }
    const logged = loggedByUser.get(userId);
    out.push({
      user_id: userId,
      name: names.get(userId) ?? null,
      pauses: rows.length,
      total_seconds: total,
      avg_seconds: Math.round(total / rows.length),
      longest_seconds: Math.max(...rows.map((r) => r.clipped)),
      exceeded_count: rows.filter((r) => r.exceeded).length,
      open_count: rows.filter((r) => r.open).length,
      by_reason: [...reasons.values()].sort((a, b) => b.total_seconds - a.total_seconds || a.reason_name.localeCompare(b.reason_name, "pt-BR")),
      logged_seconds: logged !== undefined && logged > 0 ? logged : null,
      pct_of_logged: logged !== undefined && logged > 0 ? Math.round((total / logged) * 10000) / 100 : null,
    });
  }
  return out.sort((a, b) => b.total_seconds - a.total_seconds || (a.name ?? "").localeCompare(b.name ?? "", "pt-BR"));
}

export function encodePauseCursor(row: Pick<PauseRow, "started_at" | "id">): string {
  return Buffer.from(JSON.stringify([row.started_at, row.id])).toString("base64url");
}

const TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;

export function decodePauseCursor(raw: string | null): [string, string] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && TS_RE.test(v[0]) && isUuid(v[1])) return [v[0], v[1]];
  } catch {
    /* cai no erro abaixo */
  }
  throw new PauseApiError("invalid_cursor", "`cursor` inválido", 400);
}
