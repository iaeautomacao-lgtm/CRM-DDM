// ============================================================
// Métricas, limiares e agregação de telemetria do disparador
// (Painel "Desempenho do disparador", cron_tick em system_logs).
//
// Limiares operacionais (alerta amarelo / crítico vermelho):
//   - Event loop lag p99 > 100 ms (amarelo > 50 ms)
//   - Memória RSS > 600 MB        (amarelo > 500 MB)
//   - Latência Meta p95 > 2.000 ms (amarelo > 1.500 ms)
//   - Freio acionado (backoff_events.length > 0)
//   - Erros de limite da Meta (429, 131048, 131056)
// ============================================================

export type DesempenhoWindow = "15m" | "1h" | "6h" | "24h";

export const WINDOW_MS: Record<DesempenhoWindow, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

export const RATE_LIMIT_ERROR_CODES = ["429", "131048", "131056"] as const;

export interface TickPayloadTotals {
  sent: number;
  failed: number;
  deferred: number;
  blocked: number;
  pending_confirmation: number;
  not_started?: number;
}

export interface TickPayloadKnobs {
  global_concurrency: number;
  per_number: { meta: number; waha: number; unknown?: number };
  adaptive_backoff: boolean;
  max_event_loop_lag_ms: number;
  max_rss_mb: number;
}

export interface TickPayloadChannel {
  provider: "meta" | "waha" | null;
  sent: number;
  failed: number;
  deferred: number;
  blocked: number;
  pending_confirmation: number;
  in_cooldown: boolean;
  not_started?: number;
  concurrency_start?: number | null;
  concurrency_end?: number | null;
  peak_in_flight?: number;
}

export interface LatencyMetric {
  count: number;
  avg_ms: number;
  p95_ms: number;
  max_ms: number;
}

export interface TickPayloadLatency {
  meta: LatencyMetric;
  waha: LatencyMetric;
}

export interface BackoffEventData {
  scope: "channel" | "global";
  reason: string;
  value?: number;
  session_id?: string;
  from?: number;
  to?: number;
}

export interface CronTickPayload {
  status: string;
  duration_ms: number;
  budget_ms: number;
  campaigns: number;
  stopped_early: boolean;
  knobs?: TickPayloadKnobs;
  effective_concurrency?: {
    global_start: number;
    global_end: number;
    global_peak_in_flight: number;
  };
  totals: TickPayloadTotals;
  channels?: Record<string, TickPayloadChannel>;
  latency?: TickPayloadLatency;
  provider_errors?: Record<string, number>;
  event_loop_lag_p99_ms?: number;
  rss_mb?: number;
  rss_peak_mb?: number;
  backoff_events?: BackoffEventData[];
}

export interface RawSystemLogTick {
  id: string;
  created_at: string;
  payload: CronTickPayload | null;
}

export type HealthSeverity = "ok" | "warning" | "critical";

export interface TickHealthEvaluation {
  status: HealthSeverity;
  lagCritical: boolean;
  lagWarning: boolean;
  rssCritical: boolean;
  rssWarning: boolean;
  metaLatencyCritical: boolean;
  metaLatencyWarning: boolean;
  brakeTriggered: boolean;
  rateLimitErrorsFound: string[];
  warnings: string[];
}

export interface FormattedTickRow {
  id: string;
  createdAt: string;
  durationMs: number;
  budgetMs: number;
  status: string;
  sent: number;
  failed: number;
  deferred: number;
  metaP95Ms: number;
  metaAvgMs: number;
  lagP99Ms: number;
  rssMb: number;
  rssPeakMb: number;
  globalConcurrency: number;
  peakInFlight: number;
  backoffEventsCount: number;
  backoffReasons: string[];
  rateErrors: Record<string, number>;
  evaluation: TickHealthEvaluation;
}

export interface ChannelInfo {
  id: string;
  label: string;
  provider: "meta" | "waha" | "unknown";
  phoneNumber?: string | null;
}

export interface ThroughputDataPoint {
  minute: string; // ISO string ou timestamp
  displayTime: string; // HH:mm
  total: number;
  [channelKey: string]: number | string;
}

export interface WindowMetricsSummary {
  nowSent: number;
  avgSentPerMinute: number;
  totalSent: number;
  totalTicks: number;
  latestMetaP95: number;
  avgMetaP95: number;
  latestLagP99: number;
  peakLagP99: number;
  latestRssMb: number;
  peakRssMb: number;
  hasBrakeTriggered: boolean;
  totalBackoffEvents: number;
  rateLimitErrorsTotal: number;
  rateErrorsBreakdown: Record<string, number>;
  activeKnobs: TickPayloadKnobs | null;
  budgetMs: number;
}

/** Valida e normaliza o parâmetro de janela de tempo (padrão '1h'). */
export function parseJanela(val: string | null | undefined): DesempenhoWindow {
  if (val === "15m" || val === "1h" || val === "6h" || val === "24h") {
    return val;
  }
  return "1h";
}

/** Calcula a data de início da janela. */
export function windowStartDate(
  janela: DesempenhoWindow,
  now = Date.now()
): Date {
  const ms = WINDOW_MS[janela] ?? WINDOW_MS["1h"];
  return new Date(now - ms);
}

/** Calcula a string ISO de início da janela. */
export function windowStartIso(
  janela: DesempenhoWindow,
  now = Date.now()
): string {
  return windowStartDate(janela, now).toISOString();
}

/** Limiares puros */
export function isLagCritical(lagMs: number): boolean {
  return lagMs > 100;
}

export function isLagWarning(lagMs: number): boolean {
  return lagMs > 50 && lagMs <= 100;
}

export function isRssCritical(rssMb: number): boolean {
  return rssMb > 600;
}

export function isRssWarning(rssMb: number): boolean {
  return rssMb > 500 && rssMb <= 600;
}

export function isLatencyMetaCritical(p95Ms: number): boolean {
  return p95Ms > 2000;
}

export function isLatencyMetaWarning(p95Ms: number): boolean {
  return p95Ms > 1500 && p95Ms <= 2000;
}

/** Verifica se houve freio / backoff acionado */
export function isBrakeTriggered(payload: CronTickPayload | null | undefined): boolean {
  if (!payload) return false;
  const events = payload.backoff_events ?? [];
  if (events.length > 0) return true;
  if (payload.effective_concurrency) {
    const { global_start, global_end } = payload.effective_concurrency;
    if (global_end < global_start) return true;
  }
  return false;
}

/** Detecta erros de limite da Meta (429, 131048, 131056) no mapa de erros */
export function detectRateLimitErrors(
  providerErrors: Record<string, number> | undefined | null
): string[] {
  if (!providerErrors) return [];
  const found: string[] = [];
  for (const code of RATE_LIMIT_ERROR_CODES) {
    if ((providerErrors[code] ?? 0) > 0) {
      found.push(code);
    }
  }
  return found;
}

/** Avalia a saúde operacional completa de um tick */
export function evaluateTickHealth(
  payload: CronTickPayload | null | undefined
): TickHealthEvaluation {
  if (!payload) {
    return {
      status: "ok",
      lagCritical: false,
      lagWarning: false,
      rssCritical: false,
      rssWarning: false,
      metaLatencyCritical: false,
      metaLatencyWarning: false,
      brakeTriggered: false,
      rateLimitErrorsFound: [],
      warnings: [],
    };
  }

  const lag = payload.event_loop_lag_p99_ms ?? 0;
  const rss = Math.max(payload.rss_mb ?? 0, payload.rss_peak_mb ?? 0);
  const metaP95 = payload.latency?.meta?.p95_ms ?? 0;
  const brake = isBrakeTriggered(payload);
  const rateErrors = detectRateLimitErrors(payload.provider_errors);

  const lagCrit = isLagCritical(lag);
  const lagWarn = isLagWarning(lag);
  const rssCrit = isRssCritical(rss);
  const rssWarn = isRssWarning(rss);
  const metaCrit = isLatencyMetaCritical(metaP95);
  const metaWarn = isLatencyMetaWarning(metaP95);

  const warnings: string[] = [];
  if (lagCrit) warnings.push(`Event loop lag p99 crítico (${lag} ms > 100 ms)`);
  else if (lagWarn) warnings.push(`Event loop lag p99 elevado (${lag} ms > 50 ms)`);

  if (rssCrit) warnings.push(`Memória RSS crítica (${rss} MB > 600 MB)`);
  else if (rssWarn) warnings.push(`Memória RSS elevada (${rss} MB > 500 MB)`);

  if (metaCrit) warnings.push(`Latência Meta p95 crítica (${metaP95} ms > 2.000 ms)`);
  else if (metaWarn) warnings.push(`Latência Meta p95 elevada (${metaP95} ms > 1.500 ms)`);

  if (brake) warnings.push("Freio adaptativo acionado");

  if (rateErrors.length > 0) {
    warnings.push(`Erros de limite de envio da Meta: ${rateErrors.join(", ")}`);
  }

  let status: HealthSeverity = "ok";
  if (lagCrit || rssCrit || metaCrit || brake || rateErrors.length > 0) {
    status = "critical";
  } else if (lagWarn || rssWarn || metaWarn) {
    status = "warning";
  }

  return {
    status,
    lagCritical: lagCrit,
    lagWarning: lagWarn,
    rssCritical: rssCrit,
    rssWarning: rssWarn,
    metaLatencyCritical: metaCrit,
    metaLatencyWarning: metaWarn,
    brakeTriggered: brake,
    rateLimitErrorsFound: rateErrors,
    warnings,
  };
}

/** Formata uma linha bruta de log em formato pronto para tabela da UI */
export function formatTickRow(log: RawSystemLogTick): FormattedTickRow {
  const p = log.payload;
  const evaluation = evaluateTickHealth(p);

  const rateErrors: Record<string, number> = {};
  if (p?.provider_errors) {
    for (const code of RATE_LIMIT_ERROR_CODES) {
      if ((p.provider_errors[code] ?? 0) > 0) {
        rateErrors[code] = p.provider_errors[code]!;
      }
    }
  }

  const backoffReasons = (p?.backoff_events ?? []).map((e) => e.reason);

  return {
    id: log.id,
    createdAt: log.created_at,
    durationMs: p?.duration_ms ?? 0,
    budgetMs: p?.budget_ms ?? 35000,
    status: p?.status ?? "unknown",
    sent: p?.totals?.sent ?? 0,
    failed: p?.totals?.failed ?? 0,
    deferred: p?.totals?.deferred ?? 0,
    metaP95Ms: p?.latency?.meta?.p95_ms ?? 0,
    metaAvgMs: p?.latency?.meta?.avg_ms ?? 0,
    lagP99Ms: p?.event_loop_lag_p99_ms ?? 0,
    rssMb: p?.rss_mb ?? 0,
    rssPeakMb: p?.rss_peak_mb ?? 0,
    globalConcurrency:
      p?.effective_concurrency?.global_end ??
      p?.knobs?.global_concurrency ??
      4,
    peakInFlight: p?.effective_concurrency?.global_peak_in_flight ?? 0,
    backoffEventsCount: (p?.backoff_events ?? []).length,
    backoffReasons,
    rateErrors,
    evaluation,
  };
}

/** Calcula o resumo consolidado de métricas da janela de tempo */
export function computeWindowMetrics(
  ticks: RawSystemLogTick[]
): WindowMetricsSummary {
  if (ticks.length === 0) {
    return {
      nowSent: 0,
      avgSentPerMinute: 0,
      totalSent: 0,
      totalTicks: 0,
      latestMetaP95: 0,
      avgMetaP95: 0,
      latestLagP99: 0,
      peakLagP99: 0,
      latestRssMb: 0,
      peakRssMb: 0,
      hasBrakeTriggered: false,
      totalBackoffEvents: 0,
      rateLimitErrorsTotal: 0,
      rateErrorsBreakdown: {},
      activeKnobs: null,
      budgetMs: 35000,
    };
  }

  // Ticks vêm ordenados decrescentes por created_at
  const latestTick = ticks[0]?.payload;
  const nowSent = latestTick?.totals?.sent ?? 0;

  let totalSent = 0;
  let metaP95Sum = 0;
  let metaP95Count = 0;
  let peakLag = 0;
  let peakRss = 0;
  let hasBrake = false;
  let backoffEventsTotal = 0;
  const rateErrorsBreakdown: Record<string, number> = {};
  let rateLimitTotal = 0;

  for (const t of ticks) {
    const p = t.payload;
    if (!p) continue;

    totalSent += p.totals?.sent ?? 0;

    const p95 = p.latency?.meta?.p95_ms ?? 0;
    if (p95 > 0) {
      metaP95Sum += p95;
      metaP95Count++;
    }

    const lag = p.event_loop_lag_p99_ms ?? 0;
    if (lag > peakLag) peakLag = lag;

    const rss = Math.max(p.rss_mb ?? 0, p.rss_peak_mb ?? 0);
    if (rss > peakRss) peakRss = rss;

    if (isBrakeTriggered(p)) {
      hasBrake = true;
    }

    backoffEventsTotal += (p.backoff_events ?? []).length;

    if (p.provider_errors) {
      for (const code of RATE_LIMIT_ERROR_CODES) {
        const count = p.provider_errors[code] ?? 0;
        if (count > 0) {
          rateErrorsBreakdown[code] = (rateErrorsBreakdown[code] ?? 0) + count;
          rateLimitTotal += count;
        }
      }
    }
  }

  const validTicksCount = ticks.filter((t) => !!t.payload).length;
  const avgSent = validTicksCount > 0 ? Math.round(totalSent / validTicksCount) : 0;
  const avgMetaP95 = metaP95Count > 0 ? Math.round(metaP95Sum / metaP95Count) : 0;

  return {
    nowSent,
    avgSentPerMinute: avgSent,
    totalSent,
    totalTicks: validTicksCount,
    latestMetaP95: latestTick?.latency?.meta?.p95_ms ?? 0,
    avgMetaP95,
    latestLagP99: latestTick?.event_loop_lag_p99_ms ?? 0,
    peakLagP99: peakLag,
    latestRssMb: latestTick?.rss_mb ?? 0,
    peakRssMb: peakRss,
    hasBrakeTriggered: hasBrake,
    totalBackoffEvents: backoffEventsTotal,
    rateLimitErrorsTotal: rateLimitTotal,
    rateErrorsBreakdown,
    activeKnobs: latestTick?.knobs ?? null,
    budgetMs: latestTick?.budget_ms ?? 35000,
  };
}

export interface RawThroughputRow {
  session_id: string;
  minute: string;
  sent: number;
}

/** Formata as linhas de vazão por minuto para o gráfico Recharts */
export function formatThroughputSeries(
  rows: RawThroughputRow[],
  channelsMap: Map<string, ChannelInfo>
): ThroughputDataPoint[] {
  // Agrupa por minuto (truncado)
  const byMinute = new Map<string, Record<string, number>>();

  for (const row of rows) {
    const minKey = new Date(row.minute).toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
    let entry = byMinute.get(minKey);
    if (!entry) {
      entry = {};
      byMinute.set(minKey, entry);
    }
    const channelKey = row.session_id;
    entry[channelKey] = (entry[channelKey] ?? 0) + (row.sent ?? 0);
  }

  // Ordena cronologicamente
  const sortedMinutes = Array.from(byMinute.keys()).sort();

  return sortedMinutes.map((minKey) => {
    const entry = byMinute.get(minKey) ?? {};
    const dateObj = new Date(minKey);
    const displayTime = dateObj.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });

    let total = 0;
    const point: ThroughputDataPoint = {
      minute: minKey,
      displayTime,
      total: 0,
    };

    for (const [sessionId, sentCount] of Object.entries(entry)) {
      const channel = channelsMap.get(sessionId);
      const keyName = channel ? channel.label : `Canal ${sessionId.slice(0, 8)}`;
      point[keyName] = sentCount;
      total += sentCount;
    }

    point.total = total;
    return point;
  });
}

/** Fallback: gera dados de vazão por minuto a partir dos próprios cron_ticks */
export function deriveThroughputFromTicks(
  ticks: RawSystemLogTick[],
  channelsMap: Map<string, ChannelInfo>
): ThroughputDataPoint[] {
  const rows: RawThroughputRow[] = [];

  for (const t of ticks) {
    const p = t.payload;
    if (!p) continue;
    const minute = t.created_at;

    if (p.channels && Object.keys(p.channels).length > 0) {
      for (const [sessionId, chData] of Object.entries(p.channels)) {
        if (chData.sent > 0) {
          rows.push({
            session_id: sessionId,
            minute,
            sent: chData.sent,
          });
        }
      }
    } else if (p.totals?.sent > 0) {
      // Se não houver detalhamento por canal, grava com sessão default
      rows.push({
        session_id: "global",
        minute,
        sent: p.totals.sent,
      });
    }
  }

  return formatThroughputSeries(rows, channelsMap);
}
