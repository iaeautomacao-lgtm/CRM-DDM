// PRD 20, 20.8 (complemento): as rotas gravam member.password_reset, api_key.created e api_key.revoked, sem segredo,
// e a resposta delas não muda.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SYSTEM_ROLE_PERMISSIONS } from "@/lib/auth/permissions";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  logAuditEvent: vi.fn(async () => {}),
  updateUserById: vi.fn(async () => ({ error: null as { message: string } | null })),
  profileRow: { id: "p-7", account_id: "acc-1", full_name: "Maria" } as { id: string; account_id: string; full_name: string } | null,
  insertRow: { id: "key-1", name: "Integração", scopes: ["messages:send"], user_id: null } as Record<string, unknown>,
  revokeRow: { id: "key-1", name: "Integração", scopes: ["messages:send"], user_id: null } as Record<string, unknown> | null,
}));

vi.mock("@/lib/auth/account", () => ({
  requirePermission: (...a: unknown[]) => mocks.requirePermission(...a),
  toErrorResponse: () => new Response(JSON.stringify({ error: "x" }), { status: 500 }),
}));
vi.mock("@/lib/audit/log-event", () => ({
  logAuditEvent: (...a: unknown[]) => (mocks.logAuditEvent as unknown as (...x: unknown[]) => unknown)(...a),
}));
vi.mock("@/lib/account/admin-client", () => ({
  supabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.profileRow, error: null }) }) }) }),
    auth: { admin: { updateUserById: mocks.updateUserById } },
  }),
}));
vi.mock("@/lib/flows/admin-client", () => ({ supabaseAdmin: () => ({}) }));

function chain(result: unknown): unknown {
  const b: Record<string, unknown> = {};
  for (const m of ["insert", "update", "select", "eq", "is", "order"]) b[m] = () => b;
  b.single = async () => result;
  b.maybeSingle = async () => result;
  return b;
}
const ctx = (role: "admin" | "owner" = "admin") => ({
  userId: "user-1",
  accountId: "acc-1",
  role,
  permissions: SYSTEM_ROLE_PERMISSIONS[role],
  supabase: { from: () => chain({ data: mocks.insertRow, error: null }) },
});

const reset = await import("./members/[userId]/reset-password/route");
const create = await import("./api-keys/route");
const revoke = await import("./api-keys/[id]/route");

const post = (body: unknown) =>
  new Request("http://x/api", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const del = () => new Request("http://x/api", { method: "DELETE" });

beforeEach(() => {
  mocks.logAuditEvent.mockClear();
  mocks.updateUserById.mockClear();
  mocks.profileRow = { id: "p-7", account_id: "acc-1", full_name: "Maria" };
  mocks.insertRow = { id: "key-1", name: "Integração", scopes: ["messages:send"], user_id: null };
  mocks.revokeRow = { id: "key-1", name: "Integração", scopes: ["messages:send"], user_id: null };
  mocks.requirePermission.mockReset();
});

describe("POST members/[userId]/reset-password", () => {
  it("grava member.password_reset (quem → quem) SEM a senha, e responde success", async () => {
    mocks.requirePermission.mockResolvedValue(ctx("owner"));
    const res = await reset.POST(post({ password: "senha-secreta-123" }), { params: Promise.resolve({ userId: "user-7" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(mocks.updateUserById).toHaveBeenCalledWith("user-7", { password: "senha-secreta-123" });
    expect(mocks.logAuditEvent).toHaveBeenCalledTimes(1);
    const event = (mocks.logAuditEvent.mock.calls[0] as unknown[])[0];
    expect(event).toMatchObject({
      accountId: "acc-1",
      action: "member.password_reset",
      resourceType: "member",
      resourceId: "p-7",
      resourceLabel: "Maria",
      metadata: { target_user_id: "user-7", reset_by_user_id: "user-1" },
    });
    expect(JSON.stringify(event)).not.toContain("senha-secreta-123");
  });

  it("falha ao trocar a senha: nenhum evento", async () => {
    mocks.requirePermission.mockResolvedValue(ctx("owner"));
    mocks.updateUserById.mockResolvedValueOnce({ error: { message: "boom" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await reset.POST(post({ password: "senha-secreta-123" }), { params: Promise.resolve({ userId: "user-7" }) });
    expect(res.status).toBe(500);
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });

  it("membro de outra conta: 404 e nenhum evento", async () => {
    mocks.requirePermission.mockResolvedValue(ctx("owner"));
    mocks.profileRow = { id: "p-9", account_id: "outra", full_name: "Fulano" };
    const res = await reset.POST(post({ password: "senha-secreta-123" }), { params: Promise.resolve({ userId: "user-9" }) });
    expect(res.status).toBe(404);
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });
});

describe("api-keys", () => {
  it("POST grava api_key.created sem plaintext nem hash; a resposta continua trazendo a chave UMA vez", async () => {
    mocks.requirePermission.mockResolvedValue(ctx("admin"));
    const res = await create.POST(post({ name: "Integração", scopes: ["messages:send"] }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(typeof body.plaintext).toBe("string");
    expect(mocks.logAuditEvent).toHaveBeenCalledTimes(1);
    const event = (mocks.logAuditEvent.mock.calls[0] as unknown[])[0] as { action: string; resourceId: string; metadata: Record<string, unknown> };
    expect(event).toMatchObject({
      action: "api_key.created",
      resourceId: "key-1",
      metadata: { scopes: ["messages:send"], personal: false, owner_user_id: null },
    });
    expect(JSON.stringify(event)).not.toContain(body.plaintext);
    expect(JSON.stringify(event)).not.toMatch(/key_hash|plaintext/);
  });

  it("DELETE grava api_key.revoked com id/nome/escopos/pessoal", async () => {
    mocks.requirePermission.mockResolvedValue({ ...ctx("admin"), supabase: { from: () => chain({ data: mocks.revokeRow, error: null }) } });
    const res = await revoke.DELETE(del(), { params: Promise.resolve({ id: "key-1" }) });
    expect(res.status).toBe(200);
    expect(mocks.logAuditEvent).toHaveBeenCalledTimes(1);
    expect((mocks.logAuditEvent.mock.calls[0] as unknown[])[0]).toMatchObject({
      action: "api_key.revoked",
      resourceId: "key-1",
      resourceLabel: "Integração",
      metadata: { scopes: ["messages:send"], personal: false },
    });
  });

  it("revogar chave pessoal marca personal e o dono", async () => {
    mocks.revokeRow = { id: "key-2", name: "Minha", scopes: ["intelligence:read"], user_id: "user-1" };
    mocks.requirePermission.mockResolvedValue({ ...ctx("admin"), supabase: { from: () => chain({ data: mocks.revokeRow, error: null }) } });
    await revoke.DELETE(del(), { params: Promise.resolve({ id: "key-2" }) });
    expect((mocks.logAuditEvent.mock.calls[0] as unknown[])[0]).toMatchObject({ metadata: { personal: true, owner_user_id: "user-1" } });
  });

  it("chave inexistente/já revogada: 404 e nenhum evento", async () => {
    mocks.requirePermission.mockResolvedValue({ ...ctx("admin"), supabase: { from: () => chain({ data: null, error: null }) } });
    const res = await revoke.DELETE(del(), { params: Promise.resolve({ id: "x" }) });
    expect(res.status).toBe(404);
    expect(mocks.logAuditEvent).not.toHaveBeenCalled();
  });
});
