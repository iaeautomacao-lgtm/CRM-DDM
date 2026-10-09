// Rotas /api/me/sessions*, /api/me/mfa (PRD 24, item 7): sempre o usuário da SESSÃO; auditoria sem IP/UA.
import { beforeEach, describe, expect, it, vi } from "vitest";

const S1 = "10000000-0000-4000-8000-000000000001";
const S2 = "10000000-0000-4000-8000-000000000002";
const U = "00000000-0000-0000-0000-0000000000a1";
const jwt = (id: string | null) => `h.${Buffer.from(JSON.stringify(id ? { session_id: id } : {})).toString("base64url")}.s`;

const getCurrentAccount = vi.fn();
vi.mock("@/lib/auth/account", () => ({
  getCurrentAccount: (...a: unknown[]) => getCurrentAccount(...a),
  toErrorResponse: (e: unknown) => Response.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 500 }),
}));
const rpc = vi.fn();
vi.mock("@/lib/account/admin-client", () => ({ supabaseAdmin: () => ({ rpc: (...a: unknown[]) => rpc(...a) }) }));
const logAuditEvent = vi.fn(async () => {});
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: (...a: unknown[]) => (logAuditEvent as unknown as (...x: unknown[]) => unknown)(...a) }));
const checkRateLimit = vi.fn(async () => ({ success: true }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => (checkRateLimit as unknown as (...x: unknown[]) => unknown)(...a),
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
}));

const list = await import("./route");
const one = await import("./[id]/route");
const others = await import("./revoke-others/route");
const mfa = await import("../mfa/route");

const ctx = (currentSession: string | null) => ({
  userId: U,
  accountId: "ACC",
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: jwt(currentSession) } } }) } },
});
const sessionRows = [
  { id: S1, created_at: "c", updated_at: "u", user_agent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130", ip: "203.0.113.7", aal: "aal1", not_after: null },
  { id: S2, created_at: "c", updated_at: "u", user_agent: "Mozilla/5.0 (iPhone) Safari/604", ip: "198.51.100.2", aal: "aal1", not_after: null },
];
const del = (id: string) => one.DELETE(new Request("https://x", { method: "DELETE" }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  getCurrentAccount.mockReset();
  rpc.mockReset();
  logAuditEvent.mockClear();
  checkRateLimit.mockClear();
  checkRateLimit.mockResolvedValue({ success: true });
});

describe("GET /api/me/sessions", () => {
  it("lista as do usuário da SESSÃO, marca a atual, no-store", async () => {
    getCurrentAccount.mockResolvedValue(ctx(S2));
    rpc.mockResolvedValue({ data: sessionRows, error: null });
    const res = await list.GET();
    expect(rpc).toHaveBeenCalledWith("user_sessions", { p_user: U });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { sessions } = await res.json();
    expect(sessions.map((s: { id: string; current: boolean; device: string }) => [s.id, s.current, s.device])).toEqual([[S1, false, "Chrome em Windows"], [S2, true, "Safari em iOS"]]);
  });

  it("sem login: 401 e nada é consultado; migration ausente: 503", async () => {
    getCurrentAccount.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
    expect((await list.GET()).status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    getCurrentAccount.mockResolvedValue(ctx(null));
    rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "function does not exist" } });
    expect((await list.GET()).status).toBe(503);
  });
});

describe("DELETE /api/me/sessions/{id}", () => {
  it("encerra a sessão do próprio usuário e audita só o rótulo do aparelho (sem IP/UA)", async () => {
    getCurrentAccount.mockResolvedValue(ctx(S2));
    rpc.mockImplementation(async (fn: string) => (fn === "user_sessions" ? { data: sessionRows, error: null } : { data: true, error: null }));
    const res = await del(S1);
    expect(await res.json()).toEqual({ id: S1, revoked: true, was_current: false });
    expect(rpc).toHaveBeenCalledWith("revoke_user_session", { p_user: U, p_session: S1 });
    const event = (logAuditEvent.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(event).toMatchObject({ accountId: "ACC", action: "session.revoked", resourceType: "session", resourceId: S1, resourceLabel: "Chrome em Windows" });
    expect(JSON.stringify(event)).not.toMatch(/203\.0\.113|Mozilla/);
  });

  it("sessão de outro usuário / inexistente / id inválido ⇒ 404 sem encerrar nada", async () => {
    getCurrentAccount.mockResolvedValue(ctx(S1));
    rpc.mockImplementation(async (fn: string) => (fn === "user_sessions" ? { data: sessionRows, error: null } : { data: false, error: null }));
    expect((await del("10000000-0000-4000-8000-0000000000ff")).status).toBe(404);
    expect((await del("nao-e-uuid")).status).toBe(404);
    expect(rpc.mock.calls.some((c) => c[0] === "revoke_user_session")).toBe(false);
    rpc.mockImplementation(async (fn: string) => (fn === "user_sessions" ? { data: sessionRows, error: null } : { data: false, error: null })); // sumiu entre a lista e a revogação
    expect((await del(S1)).status).toBe(404);
    expect(logAuditEvent).not.toHaveBeenCalled();
  });

  it("encerrar a sessão ATUAL é permitido (sair) e avisa was_current; rate limit respeitado", async () => {
    getCurrentAccount.mockResolvedValue(ctx(S1));
    rpc.mockImplementation(async (fn: string) => (fn === "user_sessions" ? { data: sessionRows, error: null } : { data: true, error: null }));
    expect((await (await del(S1)).json()).was_current).toBe(true);
    checkRateLimit.mockResolvedValue({ success: false });
    rpc.mockClear();
    expect((await del(S2)).status).toBe(429);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/me/sessions/revoke-others", () => {
  it("mantém a atual, encerra as outras e audita a contagem", async () => {
    getCurrentAccount.mockResolvedValue(ctx(S1));
    rpc.mockResolvedValue({ data: 2, error: null });
    const res = await others.POST();
    expect(await res.json()).toEqual({ revoked: 2 });
    expect(rpc).toHaveBeenCalledWith("revoke_other_user_sessions", { p_user: U, p_keep: S1 });
    expect((logAuditEvent.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({ action: "session.revoked_others", metadata: { user_id: U, count: 2 } });
  });

  it("sem identificar a sessão atual: 409 e NADA é encerrado; nenhuma outra ⇒ não audita", async () => {
    getCurrentAccount.mockResolvedValue(ctx(null));
    expect((await others.POST()).status).toBe(409);
    expect(rpc).not.toHaveBeenCalled();
    getCurrentAccount.mockResolvedValue(ctx(S1));
    rpc.mockResolvedValue({ data: 0, error: null });
    expect(await (await others.POST()).json()).toEqual({ revoked: 0 });
    expect(logAuditEvent).not.toHaveBeenCalled();
  });
});

describe("GET /api/me/mfa", () => {
  it("status do 2FA do próprio usuário, sem segredo", async () => {
    getCurrentAccount.mockResolvedValue(ctx(S1));
    rpc.mockResolvedValue({ data: [{ id: "f1", factor_type: "totp", friendly_name: "Celular", status: "verified", created_at: "c" }], error: null });
    const body = await (await mfa.GET()).json();
    expect(rpc).toHaveBeenCalledWith("user_mfa_factors", { p_user: U });
    expect(body).toEqual({ enabled: true, factors: [{ id: "f1", type: "totp", name: "Celular", status: "verified", created_at: "c" }] });
  });
});
