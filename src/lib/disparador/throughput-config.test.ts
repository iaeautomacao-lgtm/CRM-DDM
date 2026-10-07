import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearMemoryCooldowns,
  isInCooldown,
  rememberCooldown,
  resolveChannelConcurrency,
  resolveThroughputConfig,
} from './throughput-config';
import { TickTelemetry, summarizeLatency } from './dispatch-telemetry';

describe('resolveThroughputConfig', () => {
  it('padrões == comportamento atual (global = DISPATCH_PROCESS_CONCURRENCY, 4 por número, 35s)', () => {
    const config = resolveThroughputConfig({});
    expect(config.globalConcurrency).toBe(4);
    expect(config.perNumber).toEqual({ meta: 4, waha: 4, unknown: 4 });
    expect(config.tickBudgetMs).toBe(35_000);
    expect(config.adaptiveBackoff).toBe(true);
    expect(config.maxEventLoopLagMs).toBe(200);
    expect(config.maxRssMb).toBe(1024);
  });

  it('reaproveita DISPATCH_PROCESS_CONCURRENCY como teto global (produção = 8)', () => {
    expect(resolveThroughputConfig({ DISPATCH_PROCESS_CONCURRENCY: '8' }).globalConcurrency).toBe(8);
    // Fora da faixa: clamp em 50 (antes voltava para 4 em silêncio — REVISAO F15).
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveThroughputConfig({ DISPATCH_PROCESS_CONCURRENCY: '999' }).globalConcurrency).toBe(50);
  });

  it('WAHA não herda aumento do genérico; só com a variável própria', () => {
    const generic = resolveThroughputConfig({ DISPARADOR_PER_NUMBER_CONCURRENCY: '10' });
    expect(generic.perNumber).toEqual({ meta: 10, waha: 4, unknown: 4 });
    const lower = resolveThroughputConfig({ DISPARADOR_PER_NUMBER_CONCURRENCY: '2' });
    expect(lower.perNumber.waha).toBe(2);
    const explicit = resolveThroughputConfig({
      DISPARADOR_PER_NUMBER_CONCURRENCY_META: '12',
      DISPARADOR_PER_NUMBER_CONCURRENCY_WAHA: '1',
    });
    expect(explicit.perNumber).toEqual({ meta: 12, waha: 1, unknown: 1 });
  });

  it('limita valores fora da faixa e ignora lixo', () => {
    const config = resolveThroughputConfig({
      DISPARADOR_PER_NUMBER_CONCURRENCY_META: '500',
      DISPARADOR_TICK_BUDGET_MS: '120000',
      DISPARADOR_ADAPTIVE_BACKOFF: '0',
      DISPARADOR_MAX_RSS_MB: 'abc',
    });
    expect(config.perNumber.meta).toBe(50);
    expect(config.tickBudgetMs).toBe(50_000);
    expect(config.adaptiveBackoff).toBe(false);
    expect(config.maxRssMb).toBe(1024);
  });
});

describe('resolveChannelConcurrency e cooldown', () => {
  afterEach(() => clearMemoryCooldowns());
  const config = resolveThroughputConfig({ DISPARADOR_PER_NUMBER_CONCURRENCY_META: '8' });

  it('linha de dispatch_channel_limits tem precedência sobre o env', () => {
    expect(resolveChannelConcurrency({ provider: 'meta', rowMaxInFlight: 12, inCooldown: false, config })).toBe(12);
    expect(resolveChannelConcurrency({ provider: 'meta', rowMaxInFlight: null, inCooldown: false, config })).toBe(8);
    expect(resolveChannelConcurrency({ provider: 'waha', rowMaxInFlight: undefined, inCooldown: false, config })).toBe(4);
    expect(resolveChannelConcurrency({ provider: null, rowMaxInFlight: null, inCooldown: false, config })).toBe(4);
  });

  it('em cooldown começa com metade (mínimo 1)', () => {
    expect(resolveChannelConcurrency({ provider: 'meta', rowMaxInFlight: null, inCooldown: true, config })).toBe(4);
    expect(resolveChannelConcurrency({ provider: 'meta', rowMaxInFlight: 1, inCooldown: true, config })).toBe(1);
  });

  it('cooldown vale pelo banco ou pela memória do processo e expira', () => {
    expect(isInCooldown('s1', 1_000, null)).toBe(false);
    expect(isInCooldown('s1', 1_000, new Date(5_000).toISOString())).toBe(true);
    expect(isInCooldown('s1', 6_000, new Date(5_000).toISOString())).toBe(false);
    rememberCooldown('s2', 10_000);
    expect(isInCooldown('s2', 9_000)).toBe(true);
    expect(isInCooldown('s2', 10_001)).toBe(false);
  });
});

describe('telemetria do tick', () => {
  it('resume latência (média, p95 nearest-rank, máx.)', () => {
    expect(summarizeLatency([])).toEqual({ count: 0, avg_ms: 0, p95_ms: 0, max_ms: 0 });
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(summarizeLatency(samples)).toEqual({ count: 100, avg_ms: 51, p95_ms: 95, max_ms: 100 });
  });

  it('monta o payload do cron_tick com contagens por número, concorrência efetiva, latência e backoff', () => {
    const telemetry = new TickTelemetry();
    telemetry.channel('meta-1', 'meta');
    telemetry.channel('waha-1', 'waha', true);
    telemetry.recordOutcome('meta-1', 'sent');
    telemetry.recordOutcome('meta-1', 'sent');
    telemetry.recordOutcome('meta-1', 'error');
    telemetry.recordOutcome('waha-1', 'deferred');
    telemetry.recordOutcome('waha-1', 'exception');
    telemetry.recordProviderCall('meta', 100, null);
    telemetry.recordProviderCall('meta', 300, 'meta:131056');
    telemetry.recordProviderCall('waha', 50, null);
    const config = resolveThroughputConfig({ DISPATCH_PROCESS_CONCURRENCY: '8' });
    const payload = telemetry.buildPayload({
      durationMs: 12_345.6,
      status: 'processed',
      config,
      campaigns: 2,
      schedule: {
        started: 5,
        notStarted: 3,
        stoppedEarly: true,
        globalStart: 8,
        globalEnd: 8,
        globalPeakInFlight: 6,
        channels: {
          'meta-1': { started: 3, notStarted: 3, peakInFlight: 4, capStart: 4, capEnd: 2 },
          'waha-1': { started: 2, notStarted: 0, peakInFlight: 2, capStart: 2, capEnd: 2 },
        },
        backoffEvents: [{ scope: 'channel', channelId: 'meta-1', reason: 'rate_limit', atMs: 1, from: 4, to: 2 }],
      },
      health: { eventLoopLagP99Ms: 12.34, rssMb: 300, rssPeakMb: 320 },
    });
    expect(payload).toMatchObject({
      status: 'processed',
      duration_ms: 12_346,
      budget_ms: 35_000,
      campaigns: 2,
      stopped_early: true,
      knobs: { global_concurrency: 8, per_number: { meta: 4, waha: 4, unknown: 4 } },
      effective_concurrency: { global_start: 8, global_end: 8, global_peak_in_flight: 6 },
      totals: { sent: 2, failed: 2, deferred: 1, blocked: 0, pending_confirmation: 0, not_started: 3 },
      channels: {
        'meta-1': { provider: 'meta', sent: 2, failed: 1, not_started: 3, concurrency_start: 4, concurrency_end: 2, peak_in_flight: 4 },
        'waha-1': { provider: 'waha', deferred: 1, failed: 1, in_cooldown: true },
      },
      latency: {
        meta: { count: 2, avg_ms: 200, p95_ms: 300, max_ms: 300 },
        waha: { count: 1, avg_ms: 50, p95_ms: 50 },
      },
      provider_errors: { 'meta:131056': 1 },
      event_loop_lag_p99_ms: 12.3,
      rss_mb: 300,
      rss_peak_mb: 320,
      backoff_events: [{ scope: 'channel', session_id: 'meta-1', reason: 'rate_limit', from: 4, to: 2 }],
    });
  });
});
