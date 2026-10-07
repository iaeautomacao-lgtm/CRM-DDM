import { describe, expect, it } from "vitest";
import {
  computeWindowMetrics,
  deriveThroughputFromTicks,
  detectRateLimitErrors,
  evaluateTickHealth,
  formatThroughputSeries,
  formatTickRow,
  isBrakeTriggered,
  isLagCritical,
  isLagWarning,
  isLatencyMetaCritical,
  isLatencyMetaWarning,
  isRssCritical,
  isRssWarning,
  parseJanela,
  windowStartDate,
  type ChannelInfo,
  type CronTickPayload,
  type RawSystemLogTick,
} from "./desempenho";

describe("desempenho - parseJanela & windowStartDate", () => {
  it("valida e aceita janelas suportadas", () => {
    expect(parseJanela("15m")).toBe("15m");
    expect(parseJanela("1h")).toBe("1h");
    expect(parseJanela("6h")).toBe("6h");
    expect(parseJanela("24h")).toBe("24h");
  });

  it("retorna '1h' como fallback para entradas inválidas ou nulas", () => {
    expect(parseJanela(null)).toBe("1h");
    expect(parseJanela(undefined)).toBe("1h");
    expect(parseJanela("48h")).toBe("1h");
    expect(parseJanela("invalido")).toBe("1h");
  });

  it("calcula a data de início da janela a partir de um timestamp de referência", () => {
    const ref = 1700000000000;
    expect(windowStartDate("15m", ref).getTime()).toBe(ref - 15 * 60 * 1000);
    expect(windowStartDate("1h", ref).getTime()).toBe(ref - 60 * 60 * 1000);
    expect(windowStartDate("6h", ref).getTime()).toBe(ref - 6 * 60 * 60 * 1000);
    expect(windowStartDate("24h", ref).getTime()).toBe(ref - 24 * 60 * 60 * 1000);
  });
});

describe("desempenho - limiares e alertas", () => {
  it("avalia limiares de event loop lag", () => {
    expect(isLagWarning(30)).toBe(false);
    expect(isLagWarning(60)).toBe(true);
    expect(isLagWarning(100)).toBe(true);
    expect(isLagWarning(101)).toBe(false);

    expect(isLagCritical(99)).toBe(false);
    expect(isLagCritical(100)).toBe(false);
    expect(isLagCritical(101)).toBe(true);
  });

  it("avalia limiares de memória RSS", () => {
    expect(isRssWarning(450)).toBe(false);
    expect(isRssWarning(550)).toBe(true);
    expect(isRssWarning(600)).toBe(true);
    expect(isRssWarning(601)).toBe(false);

    expect(isRssCritical(599)).toBe(false);
    expect(isRssCritical(600)).toBe(false);
    expect(isRssCritical(601)).toBe(true);
  });

  it("avalia limiares de latência da Meta", () => {
    expect(isLatencyMetaWarning(1200)).toBe(false);
    expect(isLatencyMetaWarning(1600)).toBe(true);
    expect(isLatencyMetaWarning(2000)).toBe(true);
    expect(isLatencyMetaWarning(2001)).toBe(false);

    expect(isLatencyMetaCritical(1999)).toBe(false);
    expect(isLatencyMetaCritical(2000)).toBe(false);
    expect(isLatencyMetaCritical(2001)).toBe(true);
  });

  it("detecta freio acionado", () => {
    expect(isBrakeTriggered(null)).toBe(false);
    expect(isBrakeTriggered({ backoff_events: [] } as unknown as CronTickPayload)).toBe(false);

    // Eventos de backoff presentes
    expect(
      isBrakeTriggered({
        backoff_events: [
          { scope: "global", reason: "event_loop_lag_p99", value: 150 },
        ],
      } as unknown as CronTickPayload)
    ).toBe(true);

    // Concorrência efetiva reduzida no tick
    expect(
      isBrakeTriggered({
        backoff_events: [],
        effective_concurrency: { global_start: 12, global_end: 6, global_peak_in_flight: 6 },
      } as unknown as CronTickPayload)
    ).toBe(true);
  });

  it("detecta códigos de erro de limite de envio da Meta", () => {
    expect(detectRateLimitErrors(null)).toEqual([]);
    expect(detectRateLimitErrors({})).toEqual([]);
    expect(detectRateLimitErrors({ "500": 1, "network_error": 2 })).toEqual([]);

    expect(detectRateLimitErrors({ "429": 3, "500": 1 })).toEqual(["429"]);
    expect(detectRateLimitErrors({ "131048": 1, "131056": 2 })).toEqual(["131048", "131056"]);
  });

  it("avalia a saúde operacional completa do tick", () => {
    // Tick normal e saudável
    const healthyPayload: CronTickPayload = {
      status: "finished",
      duration_ms: 32000,
      budget_ms: 35000,
      campaigns: 1,
      stopped_early: false,
      totals: { sent: 480, failed: 0, deferred: 0, blocked: 0, pending_confirmation: 0 },
      latency: {
        meta: { count: 480, avg_ms: 850, p95_ms: 1100, max_ms: 1400 },
        waha: { count: 0, avg_ms: 0, p95_ms: 0, max_ms: 0 },
      },
      event_loop_lag_p99_ms: 22,
      rss_mb: 315,
      rss_peak_mb: 320,
      backoff_events: [],
      provider_errors: {},
    };

    const healthyEval = evaluateTickHealth(healthyPayload);
    expect(healthyEval.status).toBe("ok");
    expect(healthyEval.warnings).toHaveLength(0);

    // Tick com aviso (lag em 75ms)
    const warningPayload: CronTickPayload = {
      ...healthyPayload,
      event_loop_lag_p99_ms: 75,
    };
    const warnEval = evaluateTickHealth(warningPayload);
    expect(warnEval.status).toBe("warning");
    expect(warnEval.lagWarning).toBe(true);

    // Tick crítico por lag > 100ms e erro 429
    const criticalPayload: CronTickPayload = {
      ...healthyPayload,
      event_loop_lag_p99_ms: 120,
      provider_errors: { "429": 2 },
      backoff_events: [{ scope: "global", reason: "provider_429" }],
    };
    const critEval = evaluateTickHealth(criticalPayload);
    expect(critEval.status).toBe("critical");
    expect(critEval.lagCritical).toBe(true);
    expect(critEval.brakeTriggered).toBe(true);
    expect(critEval.rateLimitErrorsFound).toContain("429");
  });
});

describe("desempenho - agregação de métricas da janela", () => {
  it("lida graciosamente com array vazio de ticks", () => {
    const summary = computeWindowMetrics([]);
    expect(summary.totalTicks).toBe(0);
    expect(summary.nowSent).toBe(0);
    expect(summary.avgSentPerMinute).toBe(0);
    expect(summary.hasBrakeTriggered).toBe(false);
  });

  it("calcula médias, picos e totais corretamente", () => {
    const ticks: RawSystemLogTick[] = [
      {
        id: "tick-1",
        created_at: "2026-10-06T15:00:00Z",
        payload: {
          status: "finished",
          duration_ms: 30000,
          budget_ms: 35000,
          campaigns: 1,
          stopped_early: false,
          totals: { sent: 500, failed: 0, deferred: 0, blocked: 0, pending_confirmation: 0 },
          latency: {
            meta: { count: 500, avg_ms: 900, p95_ms: 1200, max_ms: 1500 },
            waha: { count: 0, avg_ms: 0, p95_ms: 0, max_ms: 0 },
          },
          event_loop_lag_p99_ms: 30,
          rss_mb: 320,
          rss_peak_mb: 340,
          backoff_events: [],
          knobs: {
            global_concurrency: 12,
            per_number: { meta: 12, waha: 2 },
            adaptive_backoff: true,
            max_event_loop_lag_ms: 200,
            max_rss_mb: 1024,
          },
        },
      },
      {
        id: "tick-2",
        created_at: "2026-10-06T14:59:00Z",
        payload: {
          status: "finished",
          duration_ms: 34000,
          budget_ms: 35000,
          campaigns: 1,
          stopped_early: false,
          totals: { sent: 300, failed: 1, deferred: 0, blocked: 0, pending_confirmation: 0 },
          latency: {
            meta: { count: 300, avg_ms: 1000, p95_ms: 1400, max_ms: 1800 },
            waha: { count: 0, avg_ms: 0, p95_ms: 0, max_ms: 0 },
          },
          event_loop_lag_p99_ms: 45,
          rss_mb: 350,
          rss_peak_mb: 360,
          backoff_events: [],
        },
      },
    ];

    const summary = computeWindowMetrics(ticks);
    expect(summary.totalTicks).toBe(2);
    expect(summary.nowSent).toBe(500);
    expect(summary.totalSent).toBe(800);
    expect(summary.avgSentPerMinute).toBe(400); // 800 / 2
    expect(summary.latestMetaP95).toBe(1200);
    expect(summary.avgMetaP95).toBe(1300); // (1200 + 1400) / 2
    expect(summary.latestLagP99).toBe(30);
    expect(summary.peakLagP99).toBe(45);
    expect(summary.latestRssMb).toBe(320);
    expect(summary.peakRssMb).toBe(360);
    expect(summary.hasBrakeTriggered).toBe(false);
    expect(summary.activeKnobs?.global_concurrency).toBe(12);
  });
});

describe("desempenho - formatação para Recharts", () => {
  it("agrupa vazão por minuto e nome do canal", () => {
    const channelsMap = new Map<string, ChannelInfo>([
      [
        "session-1",
        { id: "session-1", label: "Canal Principal", provider: "meta", phoneNumber: "551199999999" },
      ],
      [
        "session-2",
        { id: "session-2", label: "Canal Reserva", provider: "meta", phoneNumber: "551188888888" },
      ],
    ]);

    const rawRows = [
      { session_id: "session-1", minute: "2026-10-06T14:30:00.000Z", sent: 120 },
      { session_id: "session-2", minute: "2026-10-06T14:30:00.000Z", sent: 80 },
      { session_id: "session-1", minute: "2026-10-06T14:31:00.000Z", sent: 150 },
    ];

    const series = formatThroughputSeries(rawRows, channelsMap);
    expect(series).toHaveLength(2);

    expect(series[0]!["Canal Principal"]).toBe(120);
    expect(series[0]!["Canal Reserva"]).toBe(80);
    expect(series[0]!.total).toBe(200);

    expect(series[1]!["Canal Principal"]).toBe(150);
    expect(series[1]!.total).toBe(150);
  });

  it("consegue derivar vazão a partir dos ticks quando a view não tem dados", () => {
    const channelsMap = new Map<string, ChannelInfo>([
      [
        "s-1",
        { id: "s-1", label: "Linha 1", provider: "meta" },
      ],
    ]);

    const ticks: RawSystemLogTick[] = [
      {
        id: "t1",
        created_at: "2026-10-06T14:30:00Z",
        payload: {
          status: "finished",
          duration_ms: 30000,
          budget_ms: 35000,
          campaigns: 1,
          stopped_early: false,
          totals: { sent: 250, failed: 0, deferred: 0, blocked: 0, pending_confirmation: 0 },
          channels: {
            "s-1": {
              provider: "meta",
              sent: 250,
              failed: 0,
              deferred: 0,
              blocked: 0,
              pending_confirmation: 0,
              in_cooldown: false,
            },
          },
        },
      },
    ];

    const series = deriveThroughputFromTicks(ticks, channelsMap);
    expect(series).toHaveLength(1);
    expect(series[0]!["Linha 1"]).toBe(250);
    expect(series[0]!.total).toBe(250);
  });

  it("formata linha de tick individual para tabela", () => {
    const row = formatTickRow({
      id: "log-123",
      created_at: "2026-10-06T14:30:00Z",
      payload: {
        status: "finished",
        duration_ms: 33000,
        budget_ms: 35000,
        campaigns: 2,
        stopped_early: false,
        totals: { sent: 480, failed: 2, deferred: 10, blocked: 0, pending_confirmation: 0 },
        latency: {
          meta: { count: 480, avg_ms: 950, p95_ms: 1250, max_ms: 1600 },
          waha: { count: 0, avg_ms: 0, p95_ms: 0, max_ms: 0 },
        },
        event_loop_lag_p99_ms: 18,
        rss_mb: 310,
        rss_peak_mb: 315,
        backoff_events: [],
        effective_concurrency: { global_start: 12, global_end: 12, global_peak_in_flight: 12 },
      },
    });

    expect(row.id).toBe("log-123");
    expect(row.sent).toBe(480);
    expect(row.failed).toBe(2);
    expect(row.deferred).toBe(10);
    expect(row.metaP95Ms).toBe(1250);
    expect(row.evaluation.status).toBe("ok");
  });
});
