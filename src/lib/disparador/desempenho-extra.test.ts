import { describe, expect, it } from "vitest";
import {
  PAGE_SIZE,
  aggregateChannelStats,
  computeCapacity,
  fetchAllTicks,
  fetchThroughputRows,
  peakPerNumber,
} from "./desempenho-extra";
import { deriveThroughputFromTicks, type ChannelInfo, type RawSystemLogTick, type ThroughputDataPoint } from "./desempenho";

// Banco falso que reproduz o corte de 1000 linhas do PostgREST e respeita order/range.
function pagedDb(table: Record<string, Array<Record<string, unknown>>>, error?: string) {
  const requested: Array<{ table: string; from: number; to: number }> = [];
  const from = (name: string) => {
    let rows = [...(table[name] ?? [])];
    const orders: Array<{ col: string; asc: boolean }> = [];
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = () => b;
    b.in = (col: string, vals: string[]) => ((rows = rows.filter((r) => vals.includes(r[col] as string))), b);
    b.gte = (col: string, v: string) => ((rows = rows.filter((r) => String(r[col]) >= v)), b);
    b.order = (col: string, o: { ascending: boolean }) => (orders.push({ col, asc: o.ascending }), b);
    b.range = (a: number, z: number) => {
      requested.push({ table: name, from: a, to: z });
      rows.sort((x, y) => {
        for (const { col, asc } of orders) {
          if (x[col] === y[col]) continue;
          return (String(x[col]) < String(y[col]) ? -1 : 1) * (asc ? 1 : -1);
        }
        return 0;
      });
      const slice = rows.slice(a, Math.min(z, a + PAGE_SIZE - 1) + 1); // max-rows 1000
      return Promise.resolve(error ? { data: null, error: { message: error } } : { data: slice, error: null });
    };
    return b;
  };
  return { db: { from } as never, requested };
}

const minute = (n: number) => new Date(Date.UTC(2026, 9, 8, 0, 0) + n * 60_000).toISOString();

describe("fetchAllTicks — janela de 24 h inteira (antes: limit 1000 = ~16,7 h)", () => {
  it("lê as 1.440 ticks de 24 h (e mais, com tick encadeado) em páginas e preserva a ordem do mais recente", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: `t${String(i).padStart(5, "0")}`, created_at: minute(i), payload: { totals: { sent: 1 } } }));
    const { db, requested } = pagedDb({ system_logs: rows });
    const out = await fetchAllTicks(db, minute(0));
    expect(out.rows).toHaveLength(2500);
    expect(out.truncated).toBe(false);
    expect(out.rows[0].created_at).toBe(minute(2499)); // mais recente primeiro
    expect(out.rows.at(-1)?.created_at).toBe(minute(0)); // e o mais antigo da janela também veio
    expect(requested.map((r) => r.from)).toEqual([0, 1000, 2000]);
  });

  it("para na primeira página curta; sinaliza truncamento no teto de páginas; propaga erro", async () => {
    const few = pagedDb({ system_logs: [{ id: "a", created_at: minute(1), payload: null }] });
    expect(await fetchAllTicks(few.db, minute(0))).toMatchObject({ rows: [{ id: "a" }], truncated: false });
    const many = pagedDb({ system_logs: Array.from({ length: 3000 }, (_, i) => ({ id: `t${i}`, created_at: minute(i), payload: null })) });
    const capped = await fetchAllTicks(many.db, minute(0), 2);
    expect(capped).toMatchObject({ truncated: true });
    expect(capped.rows).toHaveLength(2000);
    await expect(fetchAllTicks(pagedDb({}, "boom").db, minute(0))).rejects.toMatchObject({ message: "boom" });
  });
});

describe("fetchThroughputRows — não perde os minutos MAIS RECENTES", () => {
  it("3 números × 6 h (1.080 pontos > 1000): o último minuto está na resposta, em ordem cronológica", async () => {
    const rows: Array<Record<string, unknown>> = [];
    for (let m = 0; m < 360; m++) for (const s of ["a", "b", "c"]) rows.push({ session_id: s, minute: minute(m), sent: m });
    const { db } = pagedDb({ dispatch_throughput_per_minute: rows });
    const out = await fetchThroughputRows(db, minute(0), ["a", "b", "c"]);
    expect(out.available).toBe(true);
    expect(out.truncated).toBe(false);
    expect(out.rows).toHaveLength(1080);
    expect(out.rows.at(-1)?.minute).toBe(minute(359)); // antes: cortava aqui
    expect(out.rows[0].minute).toBe(minute(0));
    const sorted = out.rows.map((r) => r.minute);
    expect([...sorted].sort()).toEqual(sorted);
  });

  it("só números pedidos (conta), sem números = vazio sem consultar, view ausente = available:false", async () => {
    const rows = [{ session_id: "a", minute: minute(1), sent: 5 }, { session_id: "OUTRA-CONTA", minute: minute(1), sent: 9 }];
    const { db, requested } = pagedDb({ dispatch_throughput_per_minute: rows });
    expect((await fetchThroughputRows(db, minute(0), ["a"])).rows).toEqual([rows[0]]);
    const none = await fetchThroughputRows(db, minute(0), []);
    expect(none).toEqual({ rows: [], truncated: false, available: true });
    expect(requested).toHaveLength(1);
    expect((await fetchThroughputRows(pagedDb({}, "relation does not exist").db, minute(0), ["a"])).available).toBe(false);
  });
});

const channels = new Map<string, ChannelInfo>([
  ["a", { id: "a", label: "Cobrança 1", provider: "meta" }],
  ["b", { id: "b", label: "WAHA 1", provider: "waha" }],
]);
const tick = (at: string, chs: Record<string, Record<string, unknown>>): RawSystemLogTick => ({
  id: at,
  created_at: at,
  payload: { status: "processed", duration_ms: 1, budget_ms: 45_000, campaigns: 1, stopped_early: false, totals: { sent: 0, failed: 0, deferred: 0, blocked: 0, pending_confirmation: 0 }, channels: chs } as never,
});

describe("aggregateChannelStats — channels{} do cron_tick por número", () => {
  it("soma por número, pico em voo, freio e cooldown; ignora canal de outra conta", () => {
    const ticks = [
      tick("2026-10-08T10:02:00Z", {
        a: { sent: 100, failed: 2, deferred: 1, blocked: 0, pending_confirmation: 1, not_started: 50, in_cooldown: true, concurrency_start: 40, concurrency_end: 20, peak_in_flight: 38 },
        OUTRA: { sent: 99999 },
      }),
      tick("2026-10-08T10:01:00Z", { a: { sent: 300, failed: 0, in_cooldown: false, concurrency_start: 40, concurrency_end: 40, peak_in_flight: 40 }, b: { sent: 10 } }),
    ];
    const stats = aggregateChannelStats(ticks, channels);
    expect(stats.map((s) => s.id)).toEqual(["a", "b"]); // ordenado por envios
    expect(stats[0]).toMatchObject({ label: "Cobrança 1", ticks: 2, sent: 400, failed: 2, deferred: 1, pendingConfirmation: 1, notStarted: 50, peakInFlight: 40, concurrencyStart: 40, concurrencyEndMin: 20, cooldownTicks: 1, brakeTicks: 1 });
    expect(JSON.stringify(stats)).not.toContain("OUTRA");
    expect(JSON.stringify(stats)).not.toContain("99999");
  });

  it("número sem tick na janela não aparece; sem ticks = vazio", () => {
    expect(aggregateChannelStats([], channels)).toEqual([]);
    expect(aggregateChannelStats([tick("2026-10-08T10:00:00Z", { b: { sent: 1 } })], channels).map((s) => s.id)).toEqual(["b"]);
  });

  it("fallback da vazão por ticks (deriveThroughputFromTicks) também só usa canais da conta", () => {
    const series = deriveThroughputFromTicks([tick("2026-10-08T10:00:00Z", { a: { sent: 7 }, OUTRA: { sent: 5000 } })], channels);
    expect(series).toHaveLength(1);
    expect(series[0].total).toBe(7);
    expect(JSON.stringify(series)).not.toContain("OUTRA");
  });
});

describe("computeCapacity — teto teórico × real (sem degraus fixos)", () => {
  const latest = {
    status: "processed", duration_ms: 1, budget_ms: 45_000, campaigns: 1, stopped_early: false,
    totals: { sent: 0, failed: 0, deferred: 0, blocked: 0, pending_confirmation: 0 },
    latency: { meta: { count: 1, avg_ms: 900, p95_ms: 1100, max_ms: 1500 }, waha: { count: 0, avg_ms: 0, p95_ms: 0, max_ms: 0 } },
    knobs: { global_concurrency: 48, per_number: { meta: 24, waha: 4 }, adaptive_backoff: true, max_event_loop_lag_ms: 150, max_rss_mb: 900 },
  } as never;
  const series: ThroughputDataPoint[] = [
    { minute: "m1", displayTime: "10:00", total: 1000, "Cobrança 1": 1000 },
    { minute: "m2", displayTime: "10:01", total: 1400, "Cobrança 1": 900, "WAHA 1": 500 },
  ];

  it("vagas ÷ latência × orçamento; real médio/pico; utilização do número mais ativo", () => {
    const cap = computeCapacity({ latest, series, peakPerNumber: peakPerNumber(series) });
    expect(peakPerNumber(series)).toBe(1000);
    // min(24 por número, 48 global) = 24 vagas ÷ 0,9 s × 45 s = 1.200/min por número
    expect(cap).toMatchObject({ slotsPerNumber: 24, globalConcurrency: 48, latencySeconds: 0.9, budgetSeconds: 45, theoreticalPerMinPerNumber: 1200, realAvgPerMin: 1200, realPeakPerMin: 1400, utilizationPct: 83 });
  });

  it("quanto falta para 80/s (4.800/min): vagas necessárias com o duty do tick e aviso do teto de 50", () => {
    const cap = computeCapacity({ latest, series, peakPerNumber: 1000 });
    // 80 × 0,9 = 72 vagas a 100% do tempo; com tick de 45 s a cada 60 s (75%): 96
    expect(cap.slotsFor80PerSecond).toBe(96);
    expect(cap.above50SlotCap).toBe(true);
    expect(computeCapacity({ latest, series, peakPerNumber: 0, tickPeriodSeconds: 45 }).slotsFor80PerSecond).toBe(72);
  });

  it("sem telemetria: padrões seguros e nada quebra", () => {
    const cap = computeCapacity({ latest: null, series: [], peakPerNumber: 0 });
    expect(cap).toMatchObject({ slotsPerNumber: null, theoreticalPerMinPerNumber: null, realAvgPerMin: 0, realPeakPerMin: 0, utilizationPct: null, latencySeconds: 0.85, budgetSeconds: 35 });
  });
});
