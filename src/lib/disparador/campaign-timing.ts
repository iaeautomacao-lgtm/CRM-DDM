import { openWindowDurationMs, type SendWindowConfig } from "./window-clock";

const TERMINAL_STATUSES = new Set(["encerrada", "erro", "bloqueada_por_risco"]);

export interface CampaignStatusAuditEvent {
  created_at: string;
  changes?: {
    status?: {
      before?: unknown;
      after?: unknown;
    };
  } | null;
}

export interface CampaignTimingResult {
  started_at: string | null;
  ended_at: string | null;
  active_seconds: number | null;
  paused_seconds: number | null;
  wall_clock_seconds: number | null;
  pause_count: number;
  history_complete: boolean;
}

interface ParsedEvent {
  at: number;
  before: string | null;
  after: string;
}

function parseEvent(event: CampaignStatusAuditEvent): ParsedEvent | null {
  const at = Date.parse(event.created_at);
  const before = event.changes?.status?.before;
  const after = event.changes?.status?.after;
  if (!Number.isFinite(at) || typeof after !== "string") return null;
  return {
    at,
    before: typeof before === "string" ? before : null,
    after,
  };
}

function seconds(ms: number): number {
  return Math.max(0, Math.round(ms / 1000));
}

/**
 * Reconstrói o tempo operacional a partir do histórico auditável de status
 * da campanha. O primeiro início real é a primeira transição para
 * em_execucao que NÃO seja uma retomada de pausada.
 *
 * - active_seconds: tempo em em_execucao dentro da janela de envio.
 * - paused_seconds: tempo corrido em pausada (o que o operador percebe como pausa).
 * - wall_clock_seconds: relógio corrido entre primeiro início e fim/agora.
 *
 * Se o histórico começar já numa retomada (campanha anterior à auditoria),
 * history_complete=false e as durações ficam nulas em vez de inventar um
 * início.
 */
export function computeCampaignTiming(input: {
  currentStatus: string;
  updatedAt?: string | null;
  janela: SendWindowConfig;
  events: CampaignStatusAuditEvent[];
  nowMs?: number;
}): CampaignTimingResult {
  const nowMs = input.nowMs ?? Date.now();
  const events = input.events
    .map(parseEvent)
    .filter((event): event is ParsedEvent => event !== null)
    .sort((a, b) => a.at - b.at);

  const startIndex = events.findIndex(
    (event) => event.after === "em_execucao" && event.before !== "pausada"
  );
  if (startIndex < 0) {
    return {
      started_at: null,
      ended_at: null,
      active_seconds: null,
      paused_seconds: null,
      wall_clock_seconds: null,
      pause_count: 0,
      history_complete: false,
    };
  }

  const startedAt = events[startIndex].at;
  let cursor = startedAt;
  let state = "em_execucao";
  let activeMs = 0;
  let pausedMs = 0;
  let pauseCount = 0;
  let endedAt: number | null = null;
  let historyComplete = true;

  const addSegment = (status: string, fromMs: number, toMs: number) => {
    if (toMs <= fromMs) return;
    const openMs = openWindowDurationMs(
      new Date(fromMs),
      new Date(toMs),
      input.janela
    );
    if (status === "em_execucao") activeMs += openMs;
    else if (status === "pausada") pausedMs += toMs - fromMs;
  };

  for (let i = startIndex + 1; i < events.length; i++) {
    const event = events[i];
    if (event.at < cursor) continue;

    if (event.before && event.before !== state) historyComplete = false;
    addSegment(state, cursor, event.at);

    if (event.after === "pausada" && state !== "pausada") pauseCount++;
    state = event.after;
    cursor = event.at;

    if (TERMINAL_STATUSES.has(state)) {
      endedAt = event.at;
      break;
    }
  }

  if (endedAt === null) {
    if (TERMINAL_STATUSES.has(input.currentStatus)) {
      const fallback = input.updatedAt ? Date.parse(input.updatedAt) : Number.NaN;
      if (Number.isFinite(fallback) && fallback >= cursor) {
        addSegment(state, cursor, fallback);
        endedAt = fallback;
      }
      historyComplete = false;
    } else {
      if (state !== input.currentStatus) historyComplete = false;
      const effectiveNow = Math.max(cursor, nowMs);
      addSegment(state, cursor, effectiveNow);
    }
  }

  const wallEnd = endedAt ?? Math.max(startedAt, nowMs);
  return {
    started_at: new Date(startedAt).toISOString(),
    ended_at: endedAt === null ? null : new Date(endedAt).toISOString(),
    active_seconds: seconds(activeMs),
    paused_seconds: seconds(pausedMs),
    wall_clock_seconds: seconds(wallEnd - startedAt),
    pause_count: pauseCount,
    history_complete: historyComplete,
  };
}
