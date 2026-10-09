import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetRateLimitForTests,
  __setSharedBackendForTests,
  checkRateLimit,
  checkRateLimitLocal,
  rateLimitResponse,
  type SharedBackend,
  type SharedHit,
} from "./rate-limit";

const OPTS = { limit: 3, windowMs: 60_000 };

// Sem backend compartilhado (null): só o Map do processo — o comportamento de sempre.
describe("checkRateLimit (só Map)", () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    __setSharedBackendForTests(null);
  });

  it("permits the first request and decrements remaining", async () => {
    const result = await checkRateLimit("user:1", OPTS);
    expect(result).toMatchObject({
      success: true,
      remaining: 2,
      limit: 3,
    });
    expect(result.reset).toBeGreaterThan(Date.now());
  });

  it("permits exactly `limit` requests then rejects the next", async () => {
    expect((await checkRateLimit("user:1", OPTS)).success).toBe(true);
    expect((await checkRateLimit("user:1", OPTS)).success).toBe(true);
    expect((await checkRateLimit("user:1", OPTS)).success).toBe(true);
    const over = await checkRateLimit("user:1", OPTS);
    expect(over.success).toBe(false);
    expect(over.remaining).toBe(0);
  });

  it("keeps separate counters per key", async () => {
    await checkRateLimit("user:1", OPTS);
    await checkRateLimit("user:1", OPTS);
    await checkRateLimit("user:1", OPTS);
    // user:1 is at the cap, user:2 should still be unaffected.
    const other = await checkRateLimit("user:2", OPTS);
    expect(other.success).toBe(true);
    expect(other.remaining).toBe(2);
  });

  it("opens a fresh window after `windowMs` elapses", async () => {
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-05-01T00:00:00Z").getTime();
      vi.setSystemTime(t0);
      __resetRateLimitForTests();
      __setSharedBackendForTests(null);

      await checkRateLimit("user:1", OPTS);
      await checkRateLimit("user:1", OPTS);
      await checkRateLimit("user:1", OPTS);
      expect((await checkRateLimit("user:1", OPTS)).success).toBe(false);

      // Jump just past the window.
      vi.setSystemTime(t0 + OPTS.windowMs + 1);
      const refreshed = await checkRateLimit("user:1", OPTS);
      expect(refreshed.success).toBe(true);
      expect(refreshed.remaining).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkRateLimitLocal é síncrono e usa o mesmo Map", () => {
    expect(checkRateLimitLocal("k", OPTS).success).toBe(true);
    expect(checkRateLimitLocal("k", OPTS).remaining).toBe(1);
  });
});

// PRD 14, 14.9: contador compartilhado (RPC wacrm.rate_limit_hit) como 2º nível.
describe("checkRateLimit com o contador compartilhado", () => {
  /** Backend falso com janela fixa por chave, como a RPC: conta chamadas e devolve success/remaining/resetAt. */
  function fakeShared() {
    const counts = new Map<string, number>();
    const calls: Array<{ key: string; limit: number; windowSeconds: number }> = [];
    const resetAt = Date.now() + 60_000;
    const backend: SharedBackend = async (key, limit, windowSeconds) => {
      calls.push({ key, limit, windowSeconds });
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return { success: count <= limit, remaining: Math.max(limit - count, 0), resetAt };
    };
    return { backend, calls, counts, resetAt };
  }

  beforeEach(() => {
    __resetRateLimitForTests();
  });

  it("repassa chave, limite e janela em SEGUNDOS à RPC e devolve o resultado do banco", async () => {
    const shared = fakeShared();
    __setSharedBackendForTests(shared.backend);
    const result = await checkRateLimit("send:u1", { limit: 60, windowMs: 90_000 });
    expect(shared.calls).toEqual([{ key: "send:u1", limit: 60, windowSeconds: 90 }]);
    expect(result).toEqual({ success: true, remaining: 59, reset: shared.resetAt, limit: 60 });
  });

  it("vale ENTRE processos: outra instância já gastou o orçamento no banco → nega, mesmo com o Map vazio", async () => {
    const shared = fakeShared();
    shared.counts.set("redeem:ip", 5); // outra instância já fez 5 de 5
    __setSharedBackendForTests(shared.backend);
    const result = await checkRateLimit("redeem:ip", { limit: 5, windowMs: 300_000 });
    expect(result.success).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("sobrevive a restart: o Map zerado (processo novo) não libera o que o banco já contou", async () => {
    const shared = fakeShared();
    __setSharedBackendForTests(shared.backend);
    for (let i = 0; i < 3; i++) expect((await checkRateLimit("u", OPTS)).success).toBe(true);
    expect((await checkRateLimit("u", OPTS)).success).toBe(false);
    // "restart": zera o Map do processo, o banco mantém a contagem
    __resetRateLimitForTests();
    __setSharedBackendForTests(shared.backend);
    expect((await checkRateLimit("u", OPTS)).success).toBe(false);
  });

  it("1º nível: depois que o banco nega, o Map barra sem repetir a RPC até a janela vencer", async () => {
    const shared = fakeShared();
    shared.counts.set("k", 99);
    __setSharedBackendForTests(shared.backend);
    expect((await checkRateLimit("k", OPTS)).success).toBe(false);
    expect(shared.calls).toHaveLength(1);
    expect((await checkRateLimit("k", OPTS)).success).toBe(false);
    expect((await checkRateLimit("k", OPTS)).success).toBe(false);
    expect(shared.calls).toHaveLength(1); // as duas seguintes nem chamaram a RPC
  });

  it("1º nível: o Map que já estourou o limite não faz RPC", async () => {
    const shared = fakeShared();
    __setSharedBackendForTests(shared.backend);
    for (let i = 0; i < 3; i++) await checkRateLimit("k2", OPTS);
    expect(shared.calls).toHaveLength(3);
    expect((await checkRateLimit("k2", OPTS)).success).toBe(false); // 4ª: negada pelo Map ou pelo banco
    expect(shared.calls.length).toBeLessThanOrEqual(4);
  });

  it.each([
    ["backend devolve null (RPC indisponível/ausente)", async () => null],
    ["backend lança", async (): Promise<SharedHit | null> => {
      throw new Error("banco fora");
    }],
  ])("fallback no Map quando %s: nunca derruba a rota", async (_name, backend) => {
    __setSharedBackendForTests(backend as SharedBackend);
    expect((await checkRateLimit("f", OPTS)).success).toBe(true);
    expect((await checkRateLimit("f", OPTS)).success).toBe(true);
    expect((await checkRateLimit("f", OPTS)).success).toBe(true);
    const over = await checkRateLimit("f", OPTS);
    expect(over.success).toBe(false); // o Map segue valendo
  });

  it("janela mínima de 1 s na RPC (windowMs < 1000)", async () => {
    const shared = fakeShared();
    __setSharedBackendForTests(shared.backend);
    await checkRateLimit("fast", { limit: 5, windowMs: 200 });
    expect(shared.calls[0].windowSeconds).toBe(1);
  });
});

describe("backend padrão (RPC pelo supabase-js)", () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock("@supabase/supabase-js");
    vi.resetModules();
  });

  async function withRpc(rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>) {
    vi.resetModules();
    vi.doMock("@supabase/supabase-js", () => ({ createClient: () => ({ rpc }) }));
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://db.local");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service");
    return import("./rate-limit");
  }

  it("chama wacrm.rate_limit_hit com p_key/p_limit/p_window_s e lê success/remaining/reset_at", async () => {
    const reset = new Date(Date.now() + 30_000).toISOString();
    const calls: Array<[string, Record<string, unknown>]> = [];
    const mod = await withRpc(async (fn, args) => {
      calls.push([fn, args]);
      return { data: [{ success: true, remaining: 7, reset_at: reset }], error: null };
    });
    const result = await mod.checkRateLimit("api:k", { limit: 10, windowMs: 60_000 });
    expect(calls).toEqual([["rate_limit_hit", { p_key: "api:k", p_limit: 10, p_window_s: 60 }]]);
    expect(result).toEqual({ success: true, remaining: 7, reset: new Date(reset).getTime(), limit: 10 });
  });

  it("função inexistente (221 ainda não aplicada): cai no Map e NÃO insiste (disjuntor)", async () => {
    let calls = 0;
    const mod = await withRpc(async () => {
      calls++;
      return { data: null, error: { code: "PGRST202", message: "Could not find the function wacrm.rate_limit_hit" } };
    });
    expect((await mod.checkRateLimit("a", OPTS)).success).toBe(true);
    expect((await mod.checkRateLimit("b", OPTS)).success).toBe(true);
    expect((await mod.checkRateLimit("c", OPTS)).success).toBe(true);
    expect(calls).toBe(1);
  });

  it("RPC que demora além de 1 s: cai no Map sem travar a rota", async () => {
    vi.useFakeTimers();
    try {
      const mod = await withRpc(() => new Promise(() => undefined));
      const pending = mod.checkRateLimit("slow", OPTS);
      await vi.advanceTimersByTimeAsync(1_100);
      expect((await pending).success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sem SUPABASE_SERVICE_ROLE_KEY (testes/dev): só o Map, sem erro", async () => {
    vi.resetModules();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    const mod = await import("./rate-limit");
    expect((await mod.checkRateLimit("x", OPTS)).success).toBe(true);
  });
});

describe("rateLimitResponse", () => {
  it("returns a 429 with retry / X-RateLimit headers", async () => {
    const reset = Date.now() + 30_000;
    const res = rateLimitResponse({
      success: false,
      remaining: 0,
      reset,
      limit: 60,
    });
    expect(res.status).toBe(429);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("60");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    const body = (await res.json()) as { error: string; code: string; retry_after_seconds: number };
    expect(body.code).toBe("rate_limited");
    expect(body.error).toMatch(/limite de requisições/i);
    expect(body.retry_after_seconds).toBeGreaterThan(0);
  });

  it("clamps Retry-After to a minimum of 1 second", () => {
    // Reset already in the past — the ceiling math would otherwise give 0.
    const res = rateLimitResponse({
      success: false,
      remaining: 0,
      reset: Date.now() - 5_000,
      limit: 10,
    });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
  });
});

afterEach(() => {
  __resetRateLimitForTests();
});
