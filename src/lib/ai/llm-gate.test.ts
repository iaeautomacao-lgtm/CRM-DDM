import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LlmQueueTimeoutError,
  acquireLlmSlot,
  gatedFetch,
  llmGateStats,
  parseRetryAfterMs,
  rateLimitDelayMs,
  resetLlmGate,
} from "./llm-gate";

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 200 ? "{}" : "erro", { status, headers });
}

beforeEach(() => {
  resetLlmGate();
  process.env.AI_LLM_MAX_CONCURRENCY = "2";
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.AI_LLM_MAX_CONCURRENCY;
  delete process.env.AI_LLM_429_MAX_RETRIES;
});

describe("parseRetryAfterMs / rateLimitDelayMs", () => {
  it("lê segundos e data HTTP", () => {
    expect(parseRetryAfterMs("3")).toBe(3000);
    expect(parseRetryAfterMs("0.5")).toBe(500);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("lixo")).toBeNull();
  });
  it("respeita Retry-After, aplica backoff sem header e limita ao teto", () => {
    expect(rateLimitDelayMs(1, "2", () => 0)).toBe(2000);
    expect(rateLimitDelayMs(1, null, () => 0)).toBe(1000);
    expect(rateLimitDelayMs(2, null, () => 0)).toBe(2000);
    expect(rateLimitDelayMs(1, "120", () => 0)).toBe(8000);
  });
});

describe("acquireLlmSlot", () => {
  it("limita a concorrência e libera na ordem", async () => {
    const r1 = await acquireLlmSlot();
    const r2 = await acquireLlmSlot();
    let third = false;
    const p3 = acquireLlmSlot().then((r) => {
      third = true;
      return r;
    });
    await Promise.resolve();
    expect(llmGateStats()).toEqual({ inFlight: 2, waiting: 1 });
    expect(third).toBe(false);
    r1();
    const r3 = await p3;
    expect(third).toBe(true);
    expect(llmGateStats().inFlight).toBe(2);
    r2();
    r3();
    expect(llmGateStats()).toEqual({ inFlight: 0, waiting: 0 });
  });

  it("renova o heartbeat enquanto espera e estoura com erro claro", async () => {
    vi.useFakeTimers();
    await acquireLlmSlot();
    await acquireLlmSlot();
    const onWaiting = vi.fn();
    const p = acquireLlmSlot({ onWaiting, maxWaitMs: 25_000 });
    const assertion = expect(p).rejects.toBeInstanceOf(LlmQueueTimeoutError);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(onWaiting).toHaveBeenCalledTimes(3); // 10 s, 20 s e o resto (5 s)
    expect(llmGateStats().waiting).toBe(0);
  });
});

describe("gatedFetch", () => {
  it("repete após 429 e devolve o sucesso", async () => {
    const doFetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(res(429, { "retry-after": "1" }))
      .mockResolvedValueOnce(res(200));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onWaiting = vi.fn();
    const out = await gatedFetch(doFetch, { sleep, onWaiting });
    expect(out.status).toBe(200);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(expect.any(Number));
    expect(sleep.mock.calls[0][0]).toBeGreaterThanOrEqual(1000);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(llmGateStats().inFlight).toBe(0);
  });

  it("para após o limite de tentativas e devolve o último 429", async () => {
    process.env.AI_LLM_429_MAX_RETRIES = "1";
    const doFetch = vi.fn<() => Promise<Response>>().mockImplementation(async () => res(429));
    const out = await gatedFetch(doFetch, { sleep: async () => {} });
    expect(out.status).toBe(429);
    expect(doFetch).toHaveBeenCalledTimes(2);
    expect(llmGateStats().inFlight).toBe(0);
  });

  it("não repete outros erros e libera a vaga se o fetch lançar", async () => {
    const e500 = vi.fn<() => Promise<Response>>().mockResolvedValue(res(500));
    expect((await gatedFetch(e500)).status).toBe(500);
    expect(e500).toHaveBeenCalledTimes(1);
    const boom = vi.fn<() => Promise<Response>>().mockRejectedValue(new Error("rede"));
    await expect(gatedFetch(boom)).rejects.toThrow("rede");
    expect(llmGateStats().inFlight).toBe(0);
  });

  it("libera a vaga durante a espera do 429 para outras chamadas passarem", async () => {
    process.env.AI_LLM_MAX_CONCURRENCY = "1";
    let releaseSleep: () => void = () => {};
    const sleep = () => new Promise<void>((r) => (releaseSleep = r));
    const first = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(res(429))
      .mockResolvedValueOnce(res(200));
    const p1 = gatedFetch(first, { sleep });
    await new Promise((r) => setTimeout(r, 0));
    // p1 está dormindo sem vaga: outra chamada passa direto.
    const other = await gatedFetch(async () => res(200));
    expect(other.status).toBe(200);
    releaseSleep();
    expect((await p1).status).toBe(200);
  });
});
