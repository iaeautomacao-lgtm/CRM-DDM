// POST /api/me/mfa — auditoria do 2FA (revisão de segurança 13/10): só registra se o estado real (fatores do usuário,
// RPC da 290) confirmar o evento; o navegador não consegue forjar "ativou" nem "desativou".
import { beforeEach, describe, expect, it, vi } from "vitest";

const FACTOR = "00000000-0000-4000-8000-0000000000f1";
const mocks = vi.hoisted(() => ({
  factors: [] as Array<{ id: string; status: string }>,
  audit: vi.fn<(e: unknown) => Promise<undefined>>(async () => undefined),
}));
vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: async () => ({ userId: "u1", accountId: "acc-1", role: "agent" }),
  toErrorResponse: (e: unknown) => new Response(JSON.stringify({ error: String(e) }), { status: 500 }),
}));
vi.mock("@/lib/account/admin-client", () => ({ supabaseAdmin: () => ({}) }));
vi.mock("@/lib/auth/sessions", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/sessions")>()),
  listMfaFactors: async () => ({ enabled: mocks.factors.some((f) => f.status === "verified"), factors: mocks.factors }),
}));
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: (e: unknown) => mocks.audit(e) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ success: true }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}));

const { POST } = await import("./route");
const post = (body: unknown) => POST(new Request("http://x/api/me/mfa", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  mocks.factors = [];
  mocks.audit.mockClear();
});

describe("POST /api/me/mfa (auditoria)", () => {
  it("enabled com o fator verificado: grava mfa.enabled", async () => {
    mocks.factors = [{ id: FACTOR, status: "verified" }];
    expect((await post({ event: "enabled", factor_id: FACTOR })).status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "mfa.enabled", accountId: "acc-1", metadata: { user_id: "u1", factor_id: FACTOR } }));
  });

  it("disabled com o fator removido: grava mfa.disabled", async () => {
    expect((await post({ event: "disabled", factor_id: FACTOR })).status).toBe(200);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "mfa.disabled" }));
  });

  it("estado não confere (forjado ou ainda não verificado): 409 e nada gravado", async () => {
    mocks.factors = [{ id: FACTOR, status: "unverified" }];
    expect((await post({ event: "enabled", factor_id: FACTOR })).status).toBe(409);
    mocks.factors = [{ id: FACTOR, status: "verified" }];
    expect((await post({ event: "disabled", factor_id: FACTOR })).status).toBe(409);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("corpo inválido: 400", async () => {
    expect((await post({ event: "talvez", factor_id: FACTOR })).status).toBe(400);
    expect((await post({ event: "enabled", factor_id: "x" })).status).toBe(400);
  });
});
