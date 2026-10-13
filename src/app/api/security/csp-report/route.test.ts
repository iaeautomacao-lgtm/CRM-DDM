import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ allowed: true }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ success: state.allowed, limit: 60, remaining: 0, reset: Date.now() + 1000 }),
  RATE_LIMITS: { cspReport: { limit: 60, windowMs: 60_000 } },
}));
vi.mock("@/lib/audit/context", () => ({ clientIp: () => "203.0.113.9" }));

import { POST } from "./route";

const post = (body: string | null, headers: Record<string, string> = {}) =>
  POST(new Request("https://crm.test/api/security/csp-report", { method: "POST", body, headers: { "content-type": "application/csp-report", ...headers } }));

describe("POST /api/security/csp-report", () => {
  beforeEach(() => {
    state.allowed = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("aceita uma violação, loga uma linha higienizada e responde 204 (sem sessão)", async () => {
    const res = await post(JSON.stringify({ "csp-report": { "document-uri": "https://crm.test/login?x=SEGREDO", "violated-directive": "script-src", "blocked-uri": "https://evil.example/x.js" } }));
    expect(res.status).toBe(204);
    expect(console.warn).toHaveBeenCalledTimes(1);
    const line = String((console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1]);
    expect(line).toContain("https://evil.example");
    expect(line).not.toContain("SEGREDO");
  });

  it("corpo que não é JSON: 400; corpo vazio: 204 sem log", async () => {
    expect((await post("{nao")).status).toBe(400);
    expect((await post(null)).status).toBe(204);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("acima de 16 KB: 413", async () => {
    expect((await post("x".repeat(17 * 1024))).status).toBe(413);
    expect((await post("{}", { "content-length": String(1024 * 1024) })).status).toBe(413);
  });

  it("limite por IP estourado: 429", async () => {
    state.allowed = false;
    expect((await post("{}")).status).toBe(429);
  });
});
