// Delta ao vivo do Disparador (migration 364): o banco publica no canal privado `disp:<conta>` o que mudou por campanha, no instante em que o
// motor/webhook registra. Funções PURAS: interpretar o payload e aplicar o delta nos números que as telas já mostram.
// O que o delta não sabe (fila, em voo, vazão exata) a reconciliação periódica corrige.

export const LIVE_FIELDS = ["total_enviados", "total_entregues", "total_lidos", "total_erros", "total_blacklist", "total_respostas"] as const;
export type LiveField = (typeof LIVE_FIELDS)[number];
export type LiveCampaignDelta = Partial<Record<LiveField, number>>;
export interface LiveDelta {
  /** Hora do banco no instante do fato (ms epoch) — base da latência envio → tela. */
  ts: number | null;
  campaigns: Record<string, LiveCampaignDelta>;
}

/** Reconciliação por consulta leve com o canal ao vivo / polling de antes sem ele. */
export const RECONCILE_MS = 45_000;
export const POLL_MS = 3_000;
/** Telas com taxas por minuto (Monitor, Números) reconciliam mais perto: 10 s (o snapshot tem cache de 2,5 s no servidor). */
export const RECONCILE_RATES_MS = 10_000;
export const livePollMs = (connected: boolean, reconcileMs: number = RECONCILE_MS): number => (connected ? reconcileMs : POLL_MS);

export function parseLiveDelta(raw: unknown): LiveDelta | null {
  const body = (raw && typeof raw === "object" && "payload" in raw ? (raw as { payload: unknown }).payload : raw) as
    | { ts?: unknown; campaigns?: unknown }
    | null;
  if (!body || typeof body !== "object" || !body.campaigns || typeof body.campaigns !== "object") return null;
  const campaigns: Record<string, LiveCampaignDelta> = {};
  for (const [campaignId, fields] of Object.entries(body.campaigns as Record<string, unknown>)) {
    if (!fields || typeof fields !== "object") continue;
    const out: LiveCampaignDelta = {};
    for (const f of LIVE_FIELDS) {
      const n = Number((fields as Record<string, unknown>)[f]);
      if (Number.isFinite(n) && n !== 0) out[f] = n;
    }
    if (Object.keys(out).length > 0) campaigns[campaignId] = out;
  }
  if (Object.keys(campaigns).length === 0) return null;
  const ts = typeof body.ts === "string" ? Date.parse(body.ts) : NaN;
  return { ts: Number.isFinite(ts) ? ts : null, campaigns };
}

/** Soma dos campos de todas as campanhas (ou só das `onlyCampaigns`). */
export function sumDelta(delta: LiveDelta, onlyCampaigns?: ReadonlySet<string> | null): LiveCampaignDelta {
  const total: LiveCampaignDelta = {};
  for (const [id, fields] of Object.entries(delta.campaigns)) {
    if (onlyCampaigns && !onlyCampaigns.has(id)) continue;
    for (const f of LIVE_FIELDS) if (fields[f]) total[f] = (total[f] ?? 0) + (fields[f] as number);
  }
  return total;
}

interface LiveCounts {
  queued: number;
  sending: number;
  errors: number;
  blocked: number;
  remaining: number;
  sentLast60s: number;
}

/**
 * Aplica o delta no snapshot de Desempenho: enviado/erro/bloqueio tiram o item de "em voo" (e, esgotado, da fila) e entram no seu contador.
 * `onlyCampaigns` = campanhas em execução do snapshot (as outras não contam ali).
 */
export function applyDeltaToLive<T extends LiveCounts>(live: T, delta: LiveDelta, onlyCampaigns?: ReadonlySet<string> | null): T {
  const t = sumDelta(delta, onlyCampaigns);
  const sent = Math.max(0, t.total_enviados ?? 0);
  const errors = Math.max(0, t.total_erros ?? 0);
  const blocked = Math.max(0, t.total_blacklist ?? 0);
  const leaving = sent + errors + blocked;
  if (leaving === 0) return live;
  const fromSending = Math.min(live.sending, leaving);
  const sending = live.sending - fromSending;
  const queued = Math.max(0, live.queued - (leaving - fromSending));
  return {
    ...live,
    sending,
    queued,
    remaining: queued + sending,
    errors: live.errors + errors,
    blocked: live.blocked + blocked,
    sentLast60s: live.sentLast60s + sent,
  };
}

interface LiveMetrics {
  total_enviados: number;
  total_entregues: number;
  total_lidos: number;
  total_respostas: number;
  total_blacklist: number;
  total_erros: number;
}

/** Aplica o delta de UMA campanha nos totais do modal de métricas. Devolve o mesmo objeto se nada mudou. */
export function applyDeltaToMetrics<T extends LiveMetrics>(metrics: T, campaignId: string, delta: LiveDelta): T {
  const d = delta.campaigns[campaignId];
  if (!d) return metrics;
  const next = { ...metrics };
  for (const f of LIVE_FIELDS) if (d[f]) next[f] = Math.max(0, (next[f] ?? 0) + (d[f] as number));
  return next;
}

/** Latência envio → tela em ms (null se o relógio do navegador estiver adiantado ou o payload não trouxer a hora). */
export function latencyMs(delta: LiveDelta, now: number = Date.now()): number | null {
  if (delta.ts == null) return null;
  const ms = now - delta.ts;
  return ms >= 0 && ms < 60_000 ? Math.round(ms) : null;
}

interface SnapshotCampaignRow {
  id: string;
  total: number;
  sent: number;
  errors: number;
  blocked: number;
  remaining: number;
  progressPct: number;
}

/**
 * Aplica o delta no snapshot do Monitor/Números: por campanha (enviados, erros, bloqueados, restante, progresso — mesma fórmula do cálculo do servidor)
 * e o total da fila. Taxas por minuto e ETA NÃO são mexidos: vêm da reconciliação de 10 s (RECONCILE_RATES_MS).
 */
export function applyDeltaToSnapshot<T extends { campaigns: SnapshotCampaignRow[]; totals: { queueRemaining: number } }>(snapshot: T, delta: LiveDelta): T {
  let removed = 0;
  let touched = false;
  const campaigns = snapshot.campaigns.map((c) => {
    const d = delta.campaigns[c.id];
    if (!d) return c;
    const sent = Math.max(0, d.total_enviados ?? 0);
    const errors = Math.max(0, d.total_erros ?? 0);
    const blocked = Math.max(0, d.total_blacklist ?? 0);
    const leaving = sent + errors + blocked;
    if (leaving === 0) return c;
    touched = true;
    const next = { ...c, sent: c.sent + sent, errors: c.errors + errors, blocked: c.blocked + blocked, remaining: Math.max(0, c.remaining - leaving) };
    removed += c.remaining - next.remaining;
    next.progressPct = next.total > 0 ? Math.min(100, Math.round(((next.sent + next.errors + next.blocked) / next.total) * 1000) / 10) : 0;
    return next;
  });
  if (!touched) return snapshot;
  return { ...snapshot, campaigns, totals: { ...snapshot.totals, queueRemaining: Math.max(0, snapshot.totals.queueRemaining - removed) } };
}
