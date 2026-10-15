import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/whatsapp/encryption", () => ({ encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.slice(4) }));
vi.mock("@/lib/security/ssrf-guard", async (orig) => ({ ...(await orig<typeof import("@/lib/security/ssrf-guard")>()), assertPublicUrl: async (u: string) => new URL(u) }));

const { createEndpoint, listEndpoints, updateEndpoint, validateRateLimit, DEFAULT_RATE_LIMIT_PER_MINUTE } = await import("./endpoints");

const row = { id: "11111111-1111-4111-8111-111111111111", url: "https://x.example/h", description: null, events: ["recipient.status"], status: "active", consecutive_failures: 0, last_success_at: null, last_failure_at: null, created_at: "2026-10-09T00:00:00Z" };

/** Banco falso que registra as colunas pedidas e falha com 42703 enquanto a migration 360 "não existe". */
function fakeDb(opts: { has360: boolean }) {
  const log: Array<{ op: string; select?: string; payload?: unknown }> = [];
  const from = () => {
    const call: { op: string; select?: string; payload?: unknown } = { op: "select" };
    const b: Record<string, unknown> = {};
    b.select = (cols?: string) => ((call.select = cols), b);
    b.insert = (p: unknown) => ((call.op = "insert"), (call.payload = p), b);
    b.update = (p: unknown) => ((call.op = "update"), (call.payload = p), b);
    for (const m of ["eq", "order", "limit"]) b[m] = () => b;
    b.then = (resolve: (v: unknown) => void) => {
      log.push({ ...call });
      const wantsRate = (call.select ?? "").includes("rate_limit_per_minute") || JSON.stringify(call.payload ?? {}).includes("rate_limit_per_minute");
      if (wantsRate && !opts.has360) return resolve({ data: null, error: { code: "42703", message: "column does not exist" }, count: 0 });
      const rate = opts.has360 ? { rate_limit_per_minute: (call.payload as { rate_limit_per_minute?: number } | undefined)?.rate_limit_per_minute ?? 600 } : {};
      resolve({ data: [{ ...row, ...rate }], error: null, count: 0 });
    };
    return b;
  };
  return { db: { from, rpc: async () => ({ data: true, error: null }) } as never, log };
}

describe("limite de entregas por minuto do endpoint (migration 360)", () => {
  it("validateRateLimit: inteiro de 1 a 6000", () => {
    expect(validateRateLimit(1)).toBe(1);
    expect(validateRateLimit(6000)).toBe(6000);
    for (const bad of [0, 6001, 1.5, "10", null, NaN]) expect(() => validateRateLimit(bad)).toThrowError(/rate_limit_per_minute/);
  });

  it("criar com o limite grava e devolve; sem informar, o padrão é 600", async () => {
    const f = fakeDb({ has360: true });
    const out = await createEndpoint(f.db, { accountId: "A", keyId: null, url: "https://x.example/h", events: ["recipient.status"], rateLimitPerMinute: 120 });
    expect(out.rate_limit_per_minute).toBe(120);
    expect((f.log.find((l) => l.op === "insert")!.payload as Record<string, unknown>).rate_limit_per_minute).toBe(120);
    const def = await createEndpoint(f.db, { accountId: "A", keyId: null, url: "https://x.example/h", events: ["recipient.status"] });
    expect(def.rate_limit_per_minute).toBe(DEFAULT_RATE_LIMIT_PER_MINUTE);
  });

  it("valor inválido → 400 antes de gravar", async () => {
    const f = fakeDb({ has360: true });
    await expect(createEndpoint(f.db, { accountId: "A", keyId: null, url: "https://x.example/h", events: ["recipient.status"], rateLimitPerMinute: 99999 })).rejects.toMatchObject({ status: 400 });
    await expect(updateEndpoint(f.db, "A", row.id, { rate_limit_per_minute: 0 })).rejects.toMatchObject({ status: 400 });
    expect(f.log.some((l) => l.op === "insert" || l.op === "update")).toBe(false);
  });

  it("alterar o limite pelo PATCH", async () => {
    const f = fakeDb({ has360: true });
    const out = await updateEndpoint(f.db, "A", row.id, { rate_limit_per_minute: 50 });
    expect(out.rate_limit_per_minute).toBe(50);
  });

  it("SEM a migration 360: listar/criar continuam funcionando (padrão 600); pedir o limite → 503 explicando", async () => {
    const f = fakeDb({ has360: false });
    const list = await listEndpoints(f.db, "A");
    expect(list[0].rate_limit_per_minute).toBe(600);
    const created = await createEndpoint(f.db, { accountId: "A", keyId: null, url: "https://x.example/h", events: ["recipient.status"] });
    expect(created.rate_limit_per_minute).toBe(600);
    await expect(createEndpoint(f.db, { accountId: "A", keyId: null, url: "https://x.example/h", events: ["recipient.status"], rateLimitPerMinute: 10 })).rejects.toMatchObject({ status: 503, code: "unavailable", message: expect.stringContaining("360") });
    await expect(updateEndpoint(f.db, "A", row.id, { rate_limit_per_minute: 10 })).rejects.toMatchObject({ status: 503 });
  });
});
