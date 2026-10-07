import { monitorEventLoopDelay } from "node:perf_hooks";
import type { BackoffEvent, HealthSample, SchedulerReport } from "@/lib/disparador/dispatch-scheduler";
import type { DispatchProvider, ThroughputConfig } from "@/lib/disparador/throughput-config";
import type { ProcessResult } from "@/lib/disparador/processQueue";

// ============================================================
// Telemetria do tick do disparador: UMA linha em wacrm.system_logs por
// tick (source 'disparador', event 'cron_tick'), montada aqui.
//
// Consultas úteis (Supabase SQL Editor):
//
//   -- duração, vazão e saúde por tick (últimas 6h)
//   SELECT created_at,
//          (payload->>'duration_ms')::int            AS duration_ms,
//          (payload->'totals'->>'sent')::int           AS sent,
//          (payload->>'event_loop_lag_p99_ms')::numeric AS lag_p99_ms,
//          (payload->>'rss_mb')::int                   AS rss_mb,
//          payload->'latency'                          AS latency,
//          payload->'provider_errors'                  AS provider_errors,
//          jsonb_array_length(payload->'backoff_events') AS backoffs
//   FROM wacrm.system_logs
//   WHERE source = 'disparador' AND event = 'cron_tick'
//     AND created_at > now() - interval '6 hours'
//   ORDER BY created_at DESC;
//
//   -- envios por minuto por número: view wacrm.dispatch_throughput_per_minute
//   -- (migration 164).
// ============================================================

type Outcome = ProcessResult["outcome"] | "exception";

export interface ChannelCounters {
  provider: DispatchProvider | null;
  sent: number;
  failed: number;
  deferred: number;
  blocked: number;
  pending_confirmation: number;
  in_cooldown: boolean;
}

export interface LatencySummary {
  count: number;
  avg_ms: number;
  p95_ms: number;
  max_ms: number;
}

export function summarizeLatency(samples: readonly number[]): LatencySummary {
  if (!samples.length) return { count: 0, avg_ms: 0, p95_ms: 0, max_ms: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  // p95 pelo método "nearest rank".
  const rank = Math.max(0, Math.ceil(0.95 * sorted.length) - 1);
  return {
    count: sorted.length,
    avg_ms: Math.round(sum / sorted.length),
    p95_ms: Math.round(sorted[rank]),
    max_ms: Math.round(sorted[sorted.length - 1]),
  };
}

export class TickTelemetry {
  private readonly channels = new Map<string, ChannelCounters>();
  private readonly latencies: Record<DispatchProvider, number[]> = { meta: [], waha: [] };
  private readonly providerErrors: Record<string, number> = {};

  channel(channelId: string, provider: DispatchProvider | null = null, inCooldown = false): ChannelCounters {
    let counters = this.channels.get(channelId);
    if (!counters) {
      counters = {
        provider,
        sent: 0,
        failed: 0,
        deferred: 0,
        blocked: 0,
        pending_confirmation: 0,
        in_cooldown: inCooldown,
      };
      this.channels.set(channelId, counters);
    }
    return counters;
  }

  recordOutcome(channelId: string, outcome: Outcome): void {
    const counters = this.channel(channelId);
    if (outcome === "sent") counters.sent++;
    else if (outcome === "deferred") counters.deferred++;
    else if (outcome === "blocked") counters.blocked++;
    else if (outcome === "pending_confirmation") counters.pending_confirmation++;
    else counters.failed++;
  }

  recordProviderCall(provider: DispatchProvider, latencyMs: number, errorCode: string | null): void {
    this.latencies[provider].push(latencyMs);
    if (errorCode) this.providerErrors[errorCode] = (this.providerErrors[errorCode] ?? 0) + 1;
  }

  buildPayload(params: {
    durationMs: number;
    status: string;
    config: ThroughputConfig;
    campaigns: number;
    schedule: SchedulerReport | null;
    health: { eventLoopLagP99Ms: number; rssMb: number; rssPeakMb: number };
  }): Record<string, unknown> {
    const totals = { sent: 0, failed: 0, deferred: 0, blocked: 0, pending_confirmation: 0, not_started: 0 };
    const channels: Record<string, unknown> = {};
    for (const [channelId, counters] of this.channels) {
      const report = params.schedule?.channels[channelId];
      totals.sent += counters.sent;
      totals.failed += counters.failed;
      totals.deferred += counters.deferred;
      totals.blocked += counters.blocked;
      totals.pending_confirmation += counters.pending_confirmation;
      totals.not_started += report?.notStarted ?? 0;
      channels[channelId] = {
        ...counters,
        not_started: report?.notStarted ?? 0,
        concurrency_start: report?.capStart ?? null,
        concurrency_end: report?.capEnd ?? null,
        peak_in_flight: report?.peakInFlight ?? 0,
      };
    }
    return {
      status: params.status,
      duration_ms: Math.round(params.durationMs),
      budget_ms: params.config.tickBudgetMs,
      campaigns: params.campaigns,
      stopped_early: params.schedule?.stoppedEarly ?? false,
      knobs: {
        global_concurrency: params.config.globalConcurrency,
        per_number: params.config.perNumber,
        adaptive_backoff: params.config.adaptiveBackoff,
        max_event_loop_lag_ms: params.config.maxEventLoopLagMs,
        max_rss_mb: params.config.maxRssMb,
      },
      effective_concurrency: {
        global_start: params.schedule?.globalStart ?? params.config.globalConcurrency,
        global_end: params.schedule?.globalEnd ?? params.config.globalConcurrency,
        global_peak_in_flight: params.schedule?.globalPeakInFlight ?? 0,
      },
      totals,
      channels,
      latency: {
        meta: summarizeLatency(this.latencies.meta),
        waha: summarizeLatency(this.latencies.waha),
      },
      provider_errors: this.providerErrors,
      event_loop_lag_p99_ms: Math.round(params.health.eventLoopLagP99Ms * 10) / 10,
      rss_mb: params.health.rssMb,
      rss_peak_mb: params.health.rssPeakMb,
      backoff_events: (params.schedule?.backoffEvents ?? []).map(serializeBackoff),
    };
  }
}

function serializeBackoff(event: BackoffEvent): Record<string, unknown> {
  return event.scope === "channel"
    ? { scope: "channel", session_id: event.channelId, reason: event.reason, from: event.from, to: event.to }
    : { scope: "global", reason: event.reason, value: Math.round(event.value), from: event.from, to: event.to };
}

function rssMb(): number {
  return Math.round(process.memoryUsage.rss() / (1024 * 1024));
}

/**
 * Mede event loop e memória só durante o tick (desligado no stop()).
 * sample(): p99 da janela desde a última amostra (para o backoff global).
 * summary(): p99 do tick inteiro + RSS atual e pico observado.
 */
export function startHealthMonitor() {
  const tick = monitorEventLoopDelay({ resolution: 20 });
  const window = monitorEventLoopDelay({ resolution: 20 });
  tick.enable();
  window.enable();
  let rssPeak = rssMb();
  const p99Ms = (histogram: ReturnType<typeof monitorEventLoopDelay>) =>
    histogram.count > 0 ? histogram.percentile(99) / 1e6 : 0;
  return {
    sample(): HealthSample {
      const current = rssMb();
      rssPeak = Math.max(rssPeak, current);
      const lag = p99Ms(window);
      window.reset();
      return { eventLoopLagP99Ms: lag, rssMb: current };
    },
    summary(): { eventLoopLagP99Ms: number; rssMb: number; rssPeakMb: number } {
      const current = rssMb();
      rssPeak = Math.max(rssPeak, current);
      return { eventLoopLagP99Ms: p99Ms(tick), rssMb: current, rssPeakMb: rssPeak };
    },
    stop(): void {
      tick.disable();
      window.disable();
    },
  };
}
