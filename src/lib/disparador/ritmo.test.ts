import { describe, expect, it } from "vitest";
import {
  computeRitmo,
  resolveProviderThroughput,
  SAFE_DEFAULT_LATENCY,
  SAFE_DEFAULT_LIMITS,
  type RawSystemLogTick,
} from "./ritmo";

describe("computeRitmo", () => {
  it("com lista vazia de ticks retorna padrões seguros e ok=true", () => {
    const res = computeRitmo([]);
    expect(res.ok).toBe(true);
    expect(res.limites.global_concurrency).toBe(SAFE_DEFAULT_LIMITS.global_concurrency);
    expect(res.limites.per_number.meta).toBe(SAFE_DEFAULT_LIMITS.per_number.meta);
    expect(res.limites.per_number.waha).toBe(SAFE_DEFAULT_LIMITS.per_number.waha);
    expect(res.limites.budget_seconds).toBe(35);

    expect(res.latencia.meta.avg_s).toBe(SAFE_DEFAULT_LATENCY.meta.avg_s);
    expect(res.latencia.meta.has_data).toBe(false);

    expect(res.latencia.waha.avg_s).toBe(SAFE_DEFAULT_LATENCY.waha.avg_s);
    expect(res.latencia.waha.has_data).toBe(false);
  });

  it("extrai knobs do tick mais recente e agrega latências ponderadas", () => {
    const ticks: RawSystemLogTick[] = [
      {
        id: "log-1",
        created_at: new Date(Date.now() - 60_000).toISOString(),
        payload: {
          budget_ms: 35000,
          knobs: {
            global_concurrency: 20,
            per_number: { meta: 10, waha: 3 },
          },
          latency: {
            meta: { count: 100, avg_ms: 800, p95_ms: 1100 },
            waha: { count: 20, avg_ms: 1800, p95_ms: 2200 },
          },
        },
      },
      {
        id: "log-2",
        created_at: new Date(Date.now() - 120_000).toISOString(),
        payload: {
          budget_ms: 35000,
          knobs: {
            global_concurrency: 16,
            per_number: { meta: 8, waha: 2 },
          },
          latency: {
            meta: { count: 100, avg_ms: 900, p95_ms: 1300 },
            waha: { count: 0, avg_ms: 0, p95_ms: 0 },
          },
        },
      },
    ];

    const res = computeRitmo(ticks);
    expect(res.ok).toBe(true);

    // Knobs do tick mais recente (log-1)
    expect(res.limites.global_concurrency).toBe(20);
    expect(res.limites.per_number.meta).toBe(10);
    expect(res.limites.per_number.waha).toBe(3);
    expect(res.limites.budget_seconds).toBe(35);

    // Média Meta: (100 * 800 + 100 * 900) / 200 = 850 ms → 0.85s
    expect(res.latencia.meta.avg_s).toBe(0.85);
    expect(res.latencia.meta.p95_s).toBe(1.2); // (1100 + 1300) / 2 = 1200 ms → 1.20s
    expect(res.latencia.meta.has_data).toBe(true);

    // Média WAHA: 1800 ms → 1.8s
    expect(res.latencia.waha.avg_s).toBe(1.8);
    expect(res.latencia.waha.p95_s).toBe(2.2);
    expect(res.latencia.waha.has_data).toBe(true);
  });
});

describe("resolveProviderThroughput", () => {
  it("resolve slots = min(per_number, global) e latências para Meta e WAHA", () => {
    const ritmo = computeRitmo([
      {
        id: "log-1",
        created_at: new Date().toISOString(),
        payload: {
          budget_ms: 35000,
          knobs: {
            global_concurrency: 8,
            per_number: { meta: 12, waha: 2 },
          },
          latency: {
            meta: { count: 50, avg_ms: 850, p95_ms: 1200 },
            waha: { count: 10, avg_ms: 2000, p95_ms: 2500 },
          },
        },
      },
    ]);

    // Para Meta: slots = min(12, 8) = 8
    const metaTp = resolveProviderThroughput(ritmo, "meta");
    expect(metaTp.slots).toBe(8);
    expect(metaTp.budgetSeconds).toBe(35);
    expect(metaTp.latency.otimista).toBe(0.85);
    expect(metaTp.latency.conservador).toBe(1.2);

    // Para WAHA: slots = min(2, 8) = 2
    const wahaTp = resolveProviderThroughput(ritmo, "waha");
    expect(wahaTp.slots).toBe(2);
    expect(wahaTp.budgetSeconds).toBe(35);
    expect(wahaTp.latency.otimista).toBe(2.0);
    expect(wahaTp.latency.conservador).toBe(2.5);
  });
});

describe("F27: p95 ponderado por envios e slots somando números", () => {
  const tick = (count: number, p95: number) => ({
    id: `t-${count}`,
    created_at: new Date().toISOString(),
    payload: {
      budget_ms: 35000,
      knobs: { global_concurrency: 20, per_number: { meta: 4, waha: 2 } },
      latency: { meta: { count, avg_ms: 800, p95_ms: p95 }, waha: { count: 0, avg_ms: 0, p95_ms: 0 } },
    },
  });

  it("tick com poucos envios quase não pesa no p95", () => {
    // (3 × 3000 + 997 × 1000) / 1000 = 1006 ms (média simples dos ticks daria 2000 ms)
    const ritmo = computeRitmo([tick(3, 3000), tick(997, 1000)]);
    expect(ritmo.latencia.meta.p95_s).toBe(1.01);
  });

  it("vários números somam os slots até o teto global; padrão continua 1 número", () => {
    const ritmo = computeRitmo([tick(100, 1000)]);
    expect(resolveProviderThroughput(ritmo, "meta").slots).toBe(4);
    expect(resolveProviderThroughput(ritmo, "meta", 3).slots).toBe(12);
    expect(resolveProviderThroughput(ritmo, "meta", 10).slots).toBe(20);
  });
});
