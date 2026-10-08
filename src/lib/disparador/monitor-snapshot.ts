// Monitor ao vivo do disparador (P1-8): UM snapshot por conta, barato e escopado.
//
// Fontes (nenhuma varre a fila de 100 mil itens):
//   - system_logs cron_tick (últimos 30 min) → ritmo por número (sent por tick), freios, saúde do motor;
//   - RPC wacrm.dispatch_monitor_counts (migration 189) → envios 1/5 min por número e campanha, em voo,
//     "na fila" limitado a 10.001 por número, erros dos últimos 15 min por código (coluna erro_codigo, 187);
//   - campaign_metrics_live (183) → progresso e restante por campanha (O(1));
//   - whatsapp_config / dispatch_channel_limits / dispatch_channel_cooldowns → número, limite efetivo, cooldown;
//   - dispatch_meta_131026_failures (pendentes), campaigns.pausa_automatica_motivo, system_logs da conta → feed.
// Tudo filtrado por account_id. O cron_tick não tem conta: só os canais da conta aparecem.
// A parte pura (buildMonitorSnapshot, computeEtaMinutes…) não faz IO e é coberta por testes.

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadChannelIdentities } from "./channel-label";
import { calculateThroughputPerMinute } from "./dispatch-forecast";
import { describeMetaError } from "./meta-error-catalog";
import { resolveThroughputConfig, type ThroughputConfig } from "./throughput-config";
import type { CronTickPayload } from "./desempenho";

// ── Tipos de saída ───────────────────────────────────────────────────────

export type AlertLevel = "critical" | "warning" | "info";

export interface MonitorAlert {
  id: string;
  level: AlertLevel;
  title: string;
  detail: string;
  href?: string;
}

export interface MonitorNumberRow {
  id: string;
  label: string;
  provider: "meta" | "waha" | "unknown";
  phone: string | null;
  enabled: boolean;
  connected: boolean | null;
  connectionError: string | null;
  sent1m: number;
  sent5m: number;
  /** Média por minuto dos últimos 15 min (soma dos ticks). */
  avgPerMin15: number;
  ratePerMin: number;
  inFlight: number;
  /** Teto de vagas efetivo agora (linha do banco ou padrão do provedor; metade em cooldown). */
  inFlightCap: number;
  hourlyLimit: number | null;
  /** Itens agendados neste número (limitado a 10.000+; null sem o índice 189b). */
  queued: number | null;
  queuedCapped: boolean;
  etaMinutes: number | null;
  /** Teto teórico (vagas ÷ latência × orçamento do tick) em envios/min. */
  theoreticalPerMin: number | null;
  inCooldown: boolean;
  cooldownUntil: string | null;
  brake: string | null;
  /** Limite por segundo editável (P1-5/P1-6; ainda não existe). */
  limitPerSecond: number | null;
  status: "ok" | "freio" | "cooldown" | "desligado";
}

export interface MonitorCampaignRow {
  id: string;
  nome: string;
  status: string;
  total: number;
  sent: number;
  errors: number;
  blocked: number;
  remaining: number;
  progressPct: number;
  sent1m: number;
  sent5m: number;
  ratePerMin: number;
  etaMinutes: number | null;
  errors15m: number;
  pending131026: number;
  pauseReason: string | null;
  numberLabels: string[];
}

export interface MonitorErrorRow {
  code: number | null;
  count: number;
  pct: number;
  classe: string;
  significado: string;
  acao: string;
  campaigns: Array<{ id: string; nome: string; count: number }>;
}

export interface MonitorFeedEvent {
  at: string;
  level: AlertLevel;
  type: string;
  title: string;
  detail: string | null;
  campaignId?: string | null;
}

export interface MonitorSnapshot {
  generatedAt: string;
  /** Fontes que não responderam (o resto do painel continua útil). */
  degraded: string[];
  totals: {
    sentPerMin: number;
    sentPerMin5: number;
    theoreticalPerMin: number | null;
    inFlight: number;
    inFlightCap: number;
    queueRemaining: number;
    etaMinutes: number | null;
    errors15m: number;
    errorRatePct: number;
    pending131026: number;
    runningCampaigns: number;
  };
  engine: {
    lastTickAt: string | null;
    lastTickAgeSeconds: number | null;
    lastTickStatus: string | null;
    durationMs: number | null;
    budgetMs: number | null;
    utilizationPct: number | null;
    ticks15m: number;
    stale: boolean;
  };
  numbers: MonitorNumberRow[];
  campaigns: MonitorCampaignRow[];
  errors: MonitorErrorRow[];
  events: MonitorFeedEvent[];
  alerts: MonitorAlert[];
}

// ── Entrada do cálculo puro ──────────────────────────────────────────────

export interface RawChannel {
  id: string;
  label: string;
  provider: "meta" | "waha" | "unknown";
  phone: string | null;
  enabled: boolean;
  /** Último poll de saúde na Meta: true ok, false falhou, null sem leitura (igual ao Conectado/Desconectado da tela Canais). */
  connected?: boolean | null;
  connectionError?: string | null;
}
export interface RawCampaign {
  id: string;
  nome: string;
  status: string;
  session_ids: string[] | null;
  pausa_automatica_motivo: string | null;
  updated_at: string | null;
}
export interface RawMetrics {
  total: number;
  enviados: number;
  entregues: number;
  lidos: number;
  erros: number;
  blacklist: number;
}
export interface RawTick {
  created_at: string;
  payload: CronTickPayload | null;
}
export interface RawLog {
  created_at: string;
  level: string;
  event: string;
  message: string | null;
  payload: Record<string, unknown> | null;
}
export interface DbCounts {
  sessions: Array<{ session_id: string; sent_1m: number; sent_5m: number; in_flight: number; queued: number | null }>;
  campaigns: Array<{ campaign_id: string; sent_1m: number; sent_5m: number }>;
  errors: Array<{ campaign_id: string; erro_codigo: number | null; n: number }>;
  has_queue_index?: boolean;
  has_error_code?: boolean;
}

export interface MonitorInput {
  now: Date;
  channels: RawChannel[];
  limits: Map<string, { maxInFlight: number | null; hourlyLimit: number | null }>;
  cooldowns: Map<string, { until: string | null; reason: string | null }>;
  campaigns: RawCampaign[];
  metrics: Map<string, RawMetrics>;
  pending131026: Map<string, number>;
  /** Mais recente primeiro. */
  ticks: RawTick[];
  counts: DbCounts | null;
  logs: RawLog[];
  throughput: ThroughputConfig;
  degraded: string[];
}

// ── Cálculos puros ───────────────────────────────────────────────────────

export const QUEUE_COUNT_CAP = 10_000;
/** Sem tick do cron há mais que isto (com campanha em execução) = motor parado. */
export const ENGINE_STALE_SECONDS = 180;

/** Ritmo estável: média de 5 min quando há; senão o último minuto. */
export function pickRatePerMin(sent1m: number, sent5m: number): number {
  if (sent5m > 0) return sent5m / 5;
  return Math.max(0, sent1m);
}

/** Minutos até acabar `remaining` ao ritmo `ratePerMin`; null sem ritmo; 0 se nada resta. */
export function computeEtaMinutes(remaining: number, ratePerMin: number): number | null {
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  if (!Number.isFinite(ratePerMin) || ratePerMin <= 0) return null;
  return remaining / ratePerMin;
}

export { formatEtaPt } from "./monitor-format";

const REASON_LABELS: Record<string, string> = {
  rate_limit: "limite de taxa da Meta",
  server_error: "erros 5xx do provedor",
  timeout: "timeouts do provedor",
  network: "falhas de rede",
  event_loop_lag: "servidor lento (lag do event loop)",
  rss: "memória do servidor alta",
};
export function reasonLabelPt(reason: string | undefined): string {
  return (reason && REASON_LABELS[reason]) || reason || "motivo não informado";
}

function minutesAgo(now: Date, iso: string): number {
  return (now.getTime() - Date.parse(iso)) / 60_000;
}

function sumTickSent(ticks: RawTick[], channelId: string, now: Date, windowMin: number): number {
  let sum = 0;
  for (const tick of ticks) {
    if (minutesAgo(now, tick.created_at) > windowMin) continue;
    sum += tick.payload?.channels?.[channelId]?.sent ?? 0;
  }
  return sum;
}

function latestTick(ticks: RawTick[]): RawTick | null {
  return ticks.find((t) => t.payload) ?? null;
}

function numberStatus(row: Pick<MonitorNumberRow, "enabled" | "inCooldown" | "brake">): MonitorNumberRow["status"] {
  if (!row.enabled) return "desligado";
  if (row.inCooldown) return "cooldown";
  if (row.brake) return "freio";
  return "ok";
}

const FEED_LIMIT = 30;

export function buildMonitorSnapshot(input: MonitorInput): MonitorSnapshot {
  const { now, throughput } = input;
  const accountChannelIds = new Set(input.channels.map((c) => c.id));
  const labelById = new Map(input.channels.map((c) => [c.id, c.label]));
  const campaignById = new Map(input.campaigns.map((c) => [c.id, c]));
  const counts = input.counts;
  const sessionCounts = new Map((counts?.sessions ?? []).map((s) => [s.session_id, s]));
  const campaignCounts = new Map((counts?.campaigns ?? []).map((c) => [c.campaign_id, c]));

  // Só ticks dos últimos 30 min entram nos cálculos de ritmo/feed.
  const ticks = input.ticks.filter((t) => minutesAgo(now, t.created_at) <= 30);
  const tick0 = latestTick(ticks);
  const tickBudgetS = (tick0?.payload?.budget_ms ?? throughput.tickBudgetMs) / 1000;

  // ── Por número ──
  const numbers: MonitorNumberRow[] = input.channels.map((ch) => {
    const lim = input.limits.get(ch.id);
    const providerKey = ch.provider === "unknown" ? "unknown" : ch.provider;
    const baseCap = lim?.maxInFlight && lim.maxInFlight > 0 ? lim.maxInFlight : throughput.perNumber[providerKey];
    const cd = input.cooldowns.get(ch.id);
    const dbCooldown = cd?.until ? Date.parse(cd.until) > now.getTime() : false;
    const tickCooldown = tick0?.payload?.channels?.[ch.id]?.in_cooldown === true;
    const inCooldown = dbCooldown || tickCooldown;
    const cap = inCooldown ? Math.max(1, Math.floor(baseCap / 2)) : baseCap;

    const db = sessionCounts.get(ch.id);
    const avg15 = sumTickSent(ticks, ch.id, now, 15) / 15;
    const sent1m = db?.sent_1m ?? Math.round(sumTickSent(ticks, ch.id, now, 1.5) / 1.5);
    const sent5m = db?.sent_5m ?? sumTickSent(ticks, ch.id, now, 5);
    const ratePerMin = pickRatePerMin(sent1m, sent5m);

    // Freio recente (backoff do scheduler) neste número.
    let brake: string | null = null;
    for (const tick of ticks) {
      if (minutesAgo(now, tick.created_at) > 15) continue;
      const ev = (tick.payload?.backoff_events ?? []).find((e) => e.scope === "channel" && e.session_id === ch.id);
      if (ev) {
        brake = `Concorrência cortada de ${ev.from ?? "?"} para ${ev.to ?? "?"} por ${reasonLabelPt(ev.reason)}`;
        break;
      }
    }

    const queued = db?.queued ?? null;
    const latencyMs =
      (ch.provider === "meta" ? tick0?.payload?.latency?.meta?.avg_ms : tick0?.payload?.latency?.waha?.avg_ms) || 0;
    const latencyS = latencyMs > 0 ? latencyMs / 1000 : ch.provider === "waha" ? 2 : 0.85;
    const theoretical = ch.enabled ? Math.round(calculateThroughputPerMinute(cap, latencyS, tickBudgetS)) : null;

    const row: MonitorNumberRow = {
      id: ch.id,
      label: ch.label,
      provider: ch.provider,
      phone: ch.phone,
      enabled: ch.enabled,
      connected: ch.connected ?? null,
      connectionError: ch.connectionError ?? null,
      sent1m,
      sent5m,
      avgPerMin15: Math.round(avg15 * 10) / 10,
      ratePerMin,
      inFlight: db?.in_flight ?? Math.max(0, tick0?.payload?.channels?.[ch.id]?.peak_in_flight ?? 0),
      inFlightCap: cap,
      hourlyLimit: lim?.hourlyLimit ?? null,
      queued: queued === null ? null : Math.min(queued, QUEUE_COUNT_CAP),
      queuedCapped: queued !== null && queued > QUEUE_COUNT_CAP,
      etaMinutes: queued === null ? null : computeEtaMinutes(queued, ratePerMin),
      theoreticalPerMin: theoretical,
      inCooldown,
      cooldownUntil: dbCooldown ? (cd?.until ?? null) : null,
      brake,
      limitPerSecond: null,
      status: "ok",
    };
    row.status = numberStatus(row);
    return row;
  });

  // ── Erros recentes agrupados por código ──
  const errorRows = (counts?.errors ?? []).filter((e) => campaignById.has(e.campaign_id));
  const errorsByCode = new Map<string, { code: number | null; count: number; byCampaign: Map<string, number> }>();
  const errors15mByCampaign = new Map<string, number>();
  for (const e of errorRows) {
    const key = String(e.erro_codigo ?? "null");
    const entry = errorsByCode.get(key) ?? { code: e.erro_codigo ?? null, count: 0, byCampaign: new Map() };
    entry.count += e.n;
    entry.byCampaign.set(e.campaign_id, (entry.byCampaign.get(e.campaign_id) ?? 0) + e.n);
    errorsByCode.set(key, entry);
    errors15mByCampaign.set(e.campaign_id, (errors15mByCampaign.get(e.campaign_id) ?? 0) + e.n);
  }
  const errors15m = [...errorsByCode.values()].reduce((s, e) => s + e.count, 0);
  const errors: MonitorErrorRow[] = [...errorsByCode.values()]
    .sort((a, b) => b.count - a.count)
    .map((e) => {
      const info = e.code === null ? null : describeMetaError(e.code);
      return {
        code: e.code,
        count: e.count,
        pct: errors15m > 0 ? Math.round((e.count / errors15m) * 1000) / 10 : 0,
        classe: info?.classe ?? "sem_codigo",
        significado:
          info?.significado ??
          "Erro sem código da Meta: falha local (telefone ou variável inválida, canal sem token), do WAHA ou resultado não confirmado.",
        acao: info?.acao ?? "Abra a campanha e veja o texto do erro do item para entender a causa.",
        campaigns: [...e.byCampaign.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([id, count]) => ({ id, nome: campaignById.get(id)?.nome ?? "Campanha", count })),
      };
    });

  // ── Por campanha ──
  const campaigns: MonitorCampaignRow[] = input.campaigns.map((c) => {
    const m = input.metrics.get(c.id);
    const total = m?.total ?? 0;
    const sent = m?.enviados ?? 0;
    const errs = m?.erros ?? 0;
    const blocked = m?.blacklist ?? 0;
    const remaining = Math.max(0, total - sent - errs - blocked);
    const cc = campaignCounts.get(c.id);
    const ratePerMin = pickRatePerMin(cc?.sent_1m ?? 0, cc?.sent_5m ?? 0);
    return {
      id: c.id,
      nome: c.nome,
      status: c.status,
      total,
      sent,
      errors: errs,
      blocked,
      remaining,
      progressPct: total > 0 ? Math.min(100, Math.round(((sent + errs + blocked) / total) * 1000) / 10) : 0,
      sent1m: cc?.sent_1m ?? 0,
      sent5m: cc?.sent_5m ?? 0,
      ratePerMin,
      etaMinutes: c.status === "em_execucao" ? computeEtaMinutes(remaining, ratePerMin) : null,
      errors15m: errors15mByCampaign.get(c.id) ?? 0,
      pending131026: input.pending131026.get(c.id) ?? 0,
      pauseReason: c.status === "pausada" ? c.pausa_automatica_motivo : null,
      numberLabels: (c.session_ids ?? []).filter((id) => accountChannelIds.has(id)).map((id) => labelById.get(id) ?? "Canal"),
    };
  });

  // ── Totais ──
  const enabledNumbers = numbers.filter((n) => n.enabled);
  const running = campaigns.filter((c) => c.status === "em_execucao");
  const sentPerMin = numbers.reduce((s, n) => s + n.sent1m, 0);
  const sentPerMin5 = numbers.reduce((s, n) => s + n.sent5m, 0) / 5;
  const queueRemaining = running.reduce((s, c) => s + c.remaining, 0);
  const totalRate = pickRatePerMin(sentPerMin, sentPerMin5 * 5);
  const sent15 = numbers.reduce((s, n) => s + n.avgPerMin15 * 15, 0) || sentPerMin5 * 15;
  const pendingTotal = [...input.pending131026.entries()].filter(([id]) => campaignById.has(id)).reduce((s, [, n]) => s + n, 0);

  // ── Motor ──
  const lastAt = tick0?.created_at ?? null;
  const ageS = lastAt ? Math.max(0, Math.round((now.getTime() - Date.parse(lastAt)) / 1000)) : null;
  const stale = running.length > 0 && (ageS === null || ageS > ENGINE_STALE_SECONDS);
  const durationMs = tick0?.payload?.duration_ms ?? null;
  const budgetMs = tick0?.payload?.budget_ms ?? null;
  const engine = {
    lastTickAt: lastAt,
    lastTickAgeSeconds: ageS,
    lastTickStatus: tick0?.payload?.status ?? null,
    durationMs,
    budgetMs,
    utilizationPct: durationMs !== null && budgetMs ? Math.round((durationMs / budgetMs) * 100) : null,
    ticks15m: ticks.filter((t) => minutesAgo(now, t.created_at) <= 15).length,
    stale,
  };

  // ── Alertas ──
  const alerts: MonitorAlert[] = [];
  if (stale) {
    alerts.push({
      id: "engine-stale",
      level: "critical",
      title: "O motor de envio não está rodando",
      detail:
        ageS === null
          ? "Nenhum tick do cron nos últimos 30 minutos, mas há campanha em execução. Confira o agendador do cron."
          : `Último tick há ${Math.round(ageS / 60)} min, mas há campanha em execução. Confira o agendador do cron.`,
    });
  }
  for (const c of campaigns) {
    if (c.status === "pausada" && c.pauseReason) {
      alerts.push({ id: `pause-${c.id}`, level: "critical", title: `"${c.nome}" pausada automaticamente`, detail: c.pauseReason, href: `/disparador/campanhas/${c.id}` });
    }
  }
  for (const n of numbers) {
    if (n.status === "cooldown")
      alerts.push({ id: `cooldown-${n.id}`, level: "warning", title: `${n.label} em cooldown`, detail: "O número reduziu o ritmo após limite de taxa da Meta; metade das vagas até o fim do cooldown." });
    else if (n.status === "freio")
      alerts.push({ id: `brake-${n.id}`, level: "warning", title: `${n.label} com freio recente`, detail: n.brake ?? "Concorrência reduzida automaticamente." });
  }
  if (pendingTotal > 0)
    alerts.push({ id: "pending-131026", level: "info", title: `${pendingTotal} ${pendingTotal === 1 ? "mensagem aguardando" : "mensagens aguardando"} confirmação (131026)`, detail: "Não entregues até agora; o sistema espera a confirmação de entrega (até 24 h) antes de tratar como erro definitivo." });
  const errorRatePct = errors15m > 0 ? Math.round((errors15m / Math.max(1, errors15m + sent15)) * 1000) / 10 : 0;
  if (errors15m >= 50 && errorRatePct >= 30)
    alerts.push({ id: "error-rate", level: "warning", title: `Taxa de erro alta: ${errorRatePct}% nos últimos 15 min`, detail: errors[0] ? `Principal causa: ${errors[0].significado}` : "Veja o painel de erros." });
  for (const tick of ticks) {
    if (minutesAgo(now, tick.created_at) > 15) continue;
    const g = (tick.payload?.backoff_events ?? []).find((e) => e.scope === "global");
    if (g) {
      alerts.push({ id: "global-brake", level: "warning", title: "Freio global do servidor", detail: `Concorrência reduzida por ${reasonLabelPt(g.reason)}.` });
      break;
    }
  }

  // ── Feed ──
  const events: MonitorFeedEvent[] = [];
  const EVENT_TITLES: Record<string, { title: string; level: AlertLevel }> = {
    campaign_auto_paused: { title: "Campanha pausada automaticamente", level: "critical" },
    campaign_start_failed: { title: "Falha ao iniciar campanha", level: "critical" },
    campaign_finished: { title: "Campanha finalizada", level: "info" },
    dispatch_stale_sending_recovered: { title: "Itens presos em 'enviando' resolvidos automaticamente", level: "info" },
    message_blocked_meta_131026: { title: "Número bloqueado após 131026 em 3 campanhas", level: "warning" },
    channel_quality_changed: { title: "Qualidade do número mudou", level: "warning" },
    meta_error_code_unknown: { title: "Código novo de erro da Meta fora do catálogo", level: "warning" },
  };
  for (const log of input.logs) {
    const meta = EVENT_TITLES[log.event];
    if (!meta) continue;
    const campaignId = typeof log.payload?.campaign_id === "string" ? log.payload.campaign_id : null;
    const name = campaignId ? campaignById.get(campaignId)?.nome : null;
    events.push({
      at: log.created_at,
      level: meta.level,
      type: log.event,
      title: name ? `${meta.title}: ${name}` : meta.title,
      detail: log.message,
      campaignId,
    });
  }
  let previous: RawTick | null = null;
  for (const tick of [...ticks].reverse()) {
    for (const ev of tick.payload?.backoff_events ?? []) {
      // Freio de número só aparece se o número é desta conta (o cron_tick é de todo o motor).
      if (ev.scope === "channel" && !(ev.session_id && accountChannelIds.has(ev.session_id))) continue;
      events.push({
        at: tick.created_at,
        level: "warning",
        type: "freio",
        title: ev.scope === "global" ? "Freio global do servidor" : `Freio no número ${labelById.get(ev.session_id ?? "") ?? ""}`.trim(),
        detail: `Concorrência de ${ev.from ?? "?"} para ${ev.to ?? "?"} por ${reasonLabelPt(ev.reason)}.`,
      });
    }
    if (previous && running.length > 0) {
      const gapMin = (Date.parse(tick.created_at) - Date.parse(previous.created_at)) / 60_000;
      if (gapMin > ENGINE_STALE_SECONDS / 60) {
        events.push({ at: tick.created_at, level: "warning", type: "tick_gap", title: `Motor ficou ${Math.round(gapMin)} min sem rodar`, detail: "Intervalo entre ticks do cron acima do normal." });
      }
    }
    previous = tick;
  }
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  return {
    generatedAt: now.toISOString(),
    degraded: input.degraded,
    totals: {
      sentPerMin,
      sentPerMin5: Math.round(sentPerMin5 * 10) / 10,
      theoreticalPerMin: enabledNumbers.length ? enabledNumbers.reduce((s, n) => s + (n.theoreticalPerMin ?? 0), 0) : null,
      inFlight: numbers.reduce((s, n) => s + n.inFlight, 0),
      inFlightCap: enabledNumbers.reduce((s, n) => s + n.inFlightCap, 0),
      queueRemaining,
      etaMinutes: computeEtaMinutes(queueRemaining, totalRate),
      errors15m,
      errorRatePct,
      pending131026: pendingTotal,
      runningCampaigns: running.length,
    },
    engine,
    numbers,
    campaigns,
    errors,
    events: events.slice(0, FEED_LIMIT),
    alerts: alerts.sort((a, b) => ({ critical: 0, warning: 1, info: 2 })[a.level] - ({ critical: 0, warning: 1, info: 2 })[b.level]),
  };
}

// ── IO: leitura das fontes (sempre por conta) ────────────────────────────

type Db = Pick<SupabaseClient, "from" | "rpc">;

export const MONITOR_LOG_EVENTS = [
  "campaign_auto_paused",
  "campaign_start_failed",
  "campaign_finished",
  "dispatch_stale_sending_recovered",
  "message_blocked_meta_131026",
  "channel_quality_changed",
  "meta_error_code_unknown",
];

export async function loadMonitorInput(db: Db, accountId: string, now: Date = new Date()): Promise<MonitorInput> {
  const degraded: string[] = [];
  const since30 = new Date(now.getTime() - 30 * 60_000).toISOString();
  const since24h = new Date(now.getTime() - 24 * 3_600_000).toISOString();

  const [identities, campaignsRes, ticksRes, logsRes, pendingRes] = await Promise.all([
    loadChannelIdentities(db, accountId),
    db
      .from("campaigns")
      .select("*")
      .eq("account_id", accountId)
      .in("status", ["em_execucao", "preparando", "pausada", "agendado"])
      .order("updated_at", { ascending: false })
      .limit(40),
    // O cron_tick não tem conta (motor único): só entram os canais desta conta no cálculo.
    db
      .from("system_logs")
      .select("created_at, payload")
      .eq("source", "disparador")
      .eq("event", "cron_tick")
      .gte("created_at", since30)
      .order("created_at", { ascending: false })
      .limit(80),
    db
      .from("system_logs")
      .select("created_at, level, event, message, payload")
      .eq("account_id", accountId)
      .eq("source", "disparador")
      .in("event", MONITOR_LOG_EVENTS)
      .gte("created_at", since24h)
      .order("created_at", { ascending: false })
      .limit(40),
    db
      .from("dispatch_meta_131026_failures")
      .select("campaign_id")
      .eq("account_id", accountId)
      .eq("status", "pendente")
      .limit(5000),
  ]);

  if (campaignsRes.error) throw campaignsRes.error;
  if (ticksRes.error) degraded.push("telemetria do motor (cron_tick)");
  if (logsRes.error) degraded.push("eventos recentes");
  if (pendingRes.error) degraded.push("131026 pendentes");

  // Nome/telefone iguais à tela Canais (channel-label.ts): habilitados primeiro.
  const channels: RawChannel[] = identities.map((i) => ({
    id: i.id,
    label: i.name,
    provider: i.provider,
    phone: i.phone,
    enabled: i.enabled,
    connected: i.connected,
    connectionError: i.connectionError,
  }));
  const channelIds = channels.map((c) => c.id);

  const campaigns: RawCampaign[] = (campaignsRes.data ?? []).map((c: Record<string, unknown>) => ({
    id: c.id as string,
    nome: (c.nome as string) ?? "Campanha",
    status: c.status as string,
    session_ids: (c.session_ids as string[] | null) ?? null,
    pausa_automatica_motivo: (c.pausa_automatica_motivo as string | null) ?? null,
    updated_at: (c.updated_at as string | null) ?? null,
  }));
  const campaignIds = campaigns.map((c) => c.id);

  const [limitsRes, cooldownsRes, countsRes] = await Promise.all([
    channelIds.length
      ? db.from("dispatch_channel_limits").select("session_id, max_in_flight, hourly_limit").in("session_id", channelIds)
      : Promise.resolve({ data: [], error: null }),
    channelIds.length
      ? db.from("dispatch_channel_cooldowns").select("session_id, cooldown_until, reason").in("session_id", channelIds)
      : Promise.resolve({ data: [], error: null }),
    db.rpc("dispatch_monitor_counts", { p_account_id: accountId, p_sessions: channelIds, p_campaigns: campaignIds, p_errors_minutes: 15 }),
  ]);
  if (limitsRes.error) degraded.push("limites por número");
  if (cooldownsRes.error) degraded.push("cooldowns");
  let counts: DbCounts | null = null;
  if (countsRes.error) degraded.push("contagens ao vivo (migration 189 não aplicada?)");
  else counts = countsRes.data as DbCounts;

  // Progresso por campanha: view live (183) com fallback para a tabela.
  const metrics = new Map<string, RawMetrics>();
  if (campaignIds.length) {
    type MetricRow = Record<string, number | string>;
    let rows: MetricRow[] = [];
    const live = await db
      .from("campaign_metrics_live")
      .select("campaign_id, total_contatos, total_enviados, total_entregues, total_lidos, total_erros, total_blacklist")
      .in("campaign_id", campaignIds);
    if (!live.error) rows = (live.data ?? []) as unknown as MetricRow[];
    else {
      const base = await db
        .from("campaign_metrics")
        .select("campaign_id, total_contatos, total_enviados, total_entregues, total_lidos, total_erros, total_blacklist")
        .in("campaign_id", campaignIds);
      if (!base.error) rows = (base.data ?? []) as unknown as MetricRow[];
      else degraded.push("métricas das campanhas");
    }
    for (const r of rows) {
      metrics.set(r.campaign_id as string, {
        total: Number(r.total_contatos ?? 0),
        enviados: Number(r.total_enviados ?? 0),
        entregues: Number(r.total_entregues ?? 0),
        lidos: Number(r.total_lidos ?? 0),
        erros: Number(r.total_erros ?? 0),
        blacklist: Number(r.total_blacklist ?? 0),
      });
    }
  }

  const pending131026 = new Map<string, number>();
  for (const r of (pendingRes.data ?? []) as Array<{ campaign_id: string }>) {
    pending131026.set(r.campaign_id, (pending131026.get(r.campaign_id) ?? 0) + 1);
  }

  return {
    now,
    channels,
    limits: new Map(
      ((limitsRes.data ?? []) as Array<{ session_id: string; max_in_flight: number | null; hourly_limit: number | null }>).map((r) => [
        r.session_id,
        { maxInFlight: r.max_in_flight, hourlyLimit: r.hourly_limit },
      ]),
    ),
    cooldowns: new Map(
      ((cooldownsRes.data ?? []) as Array<{ session_id: string; cooldown_until: string | null; reason: string | null }>).map((r) => [
        r.session_id,
        { until: r.cooldown_until, reason: r.reason },
      ]),
    ),
    campaigns,
    metrics,
    pending131026,
    ticks: (ticksRes.data ?? []) as RawTick[],
    counts,
    logs: (logsRes.data ?? []) as RawLog[],
    throughput: resolveThroughputConfig(),
    degraded,
  };
}

// ── Cache de 2,5 s por conta (só dedupe de abas/polling; não é estado do motor) ──
const CACHE_TTL_MS = 2_500;
const cache = new Map<string, { at: number; value: MonitorSnapshot }>();
const inflight = new Map<string, Promise<MonitorSnapshot>>();

/** Só para testes. */
export function clearMonitorCache(): void {
  cache.clear();
  inflight.clear();
}

export async function getMonitorSnapshot(db: Db, accountId: string, now: () => Date = () => new Date()): Promise<MonitorSnapshot> {
  const hit = cache.get(accountId);
  if (hit && now().getTime() - hit.at < CACHE_TTL_MS) return hit.value;
  const pending = inflight.get(accountId);
  if (pending) return pending;
  const run = (async () => {
    try {
      const input = await loadMonitorInput(db, accountId, now());
      const value = buildMonitorSnapshot(input);
      cache.set(accountId, { at: now().getTime(), value });
      return value;
    } finally {
      inflight.delete(accountId);
    }
  })();
  inflight.set(accountId, run);
  return run;
}
