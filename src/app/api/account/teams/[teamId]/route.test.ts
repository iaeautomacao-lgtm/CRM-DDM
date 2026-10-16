import { beforeEach, describe, expect, it, vi } from "vitest";

type Reply = { data?: unknown; error?: { code?: string } | null };
const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  audit: vi.fn(async (_p: unknown) => undefined),
  replies: [] as Array<{ op: string; reply: { data?: unknown; error?: { code?: string } | null } }>,
  calls: [] as Array<{ table: string; op: string; payload?: unknown; filters: unknown[][] }>,
}));
vi.mock("@/lib/auth/account", () => ({
  requirePermission: mocks.requirePermission,
  toErrorResponse: (e: unknown) => new Response(JSON.stringify({ error: (e as Error).message }), { status: (e as { status?: number }).status ?? 500 }),
}));
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: mocks.audit }));
vi.mock("@/lib/account/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const call = { table, op: "select", payload: undefined as unknown, filters: [] as unknown[][] };
      mocks.calls.push(call);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "limit"]) b[m] = () => b;
      b.eq = (...a: unknown[]) => {
        call.filters.push(a);
        return b;
      };
      b.update = (p: unknown) => {
        call.op = "update";
        call.payload = p;
        return b;
      };
      b.then = (ok: (v: unknown) => unknown) => {
        const i = mocks.replies.findIndex((r) => r.op === `${table}.${call.op}`);
        const r: Reply = i >= 0 ? mocks.replies.splice(i, 1)[0].reply : { data: [], error: null };
        return Promise.resolve({ data: r.data ?? [], error: r.error ?? null }).then(ok);
      };
      return b;
    },
  }),
}));

import { PATCH } from "./route";

const TEAM = "11111111-1111-4111-8111-111111111111";
const patch = (body: unknown, id = TEAM) => PATCH(new Request("http://x", { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) }), { params: Promise.resolve({ teamId: id }) });
const queue = (op: string, data: unknown, error: Reply["error"] = null) => mocks.replies.push({ op, reply: { data, error } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.replies.length = 0;
  mocks.calls.length = 0;
  mocks.requirePermission.mockResolvedValue({ accountId: "acc-1" });
});

describe("PATCH /api/account/teams/{teamId} — SLA de primeira resposta", () => {
  it("exige teams.manage; sem ela nada é lido nem gravado", async () => {
    mocks.requirePermission.mockRejectedValue(Object.assign(new Error("negado"), { status: 403 }));
    expect((await patch({ first_response_sla_min: 20 })).status).toBe(403);
    expect(mocks.requirePermission).toHaveBeenCalledWith("teams.manage");
    expect(mocks.calls).toHaveLength(0);
  });
  it("faixa e forma: 400 em pt-br e nada vai ao banco", async () => {
    for (const body of [{ first_response_sla_min: 0 }, { first_response_sla_min: 1441 }, { first_response_sla_min: 2.5 }, { first_response_sla_min: "20" }, { first_response_sla_min: true }, {}, [], "nao-json"]) {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("O SLA da primeira resposta deve ser um número inteiro de 1 a 1440 minutos, ou vazio para usar o padrão da conta.");
    }
    expect(mocks.calls).toHaveLength(0);
  });
  it("id que não é uuid ou equipe de outra conta = 404", async () => {
    expect((await patch({ first_response_sla_min: 20 }, "x")).status).toBe(404);
    queue("teams.select", []);
    const res = await patch({ first_response_sla_min: 20 });
    expect(res.status).toBe(404);
    expect(mocks.calls.every((c) => c.filters.some((f) => f[0] === "account_id" && f[1] === "acc-1"))).toBe(true);
    expect(mocks.calls.some((c) => c.op === "update")).toBe(false);
  });
  it("grava, audita antes/depois só com valores e id da equipe, e devolve a meta efetiva", async () => {
    queue("teams.select", [{ id: TEAM, first_response_sla_min: null }]);
    queue("teams.update", [{ id: TEAM }]);
    queue("account_settings.select", [{ value: 25 }]);
    queue("teams.select", [{ id: TEAM, first_response_sla_min: 40 }]);
    const res = await patch({ first_response_sla_min: 40 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ team_id: TEAM, first_response_sla_min: 40, effective_min: 40 });
    expect(mocks.calls.find((c) => c.op === "update")!.payload).toMatchObject({ first_response_sla_min: 40 });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0][0]).toMatchObject({ accountId: "acc-1", resourceType: "team", resourceId: TEAM, action: "team.sla_changed", changes: { first_response_sla_min: { before: null, after: 40 } } });
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toMatch(/name|nome|phone|telefone/i);
  });
  it("null volta ao padrão da conta; valor igual ao atual não gera auditoria", async () => {
    queue("teams.select", [{ id: TEAM, first_response_sla_min: 40 }]);
    queue("teams.update", [{ id: TEAM }]);
    queue("account_settings.select", [{ value: 25 }]);
    queue("teams.select", [{ id: TEAM, first_response_sla_min: null }]);
    const res = await patch({ first_response_sla_min: null });
    expect(await res.json()).toEqual({ team_id: TEAM, first_response_sla_min: null, effective_min: 25 });
    expect(mocks.audit.mock.calls[0][0]).toMatchObject({ changes: { first_response_sla_min: { before: 40, after: null } } });

    mocks.audit.mockClear();
    queue("teams.select", [{ id: TEAM, first_response_sla_min: 40 }]);
    queue("teams.update", [{ id: TEAM }]);
    await patch({ first_response_sla_min: 40 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("sem a migration 381 = 503; erro do banco = 500 sem detalhe", async () => {
    queue("teams.select", null, { code: "42703" });
    const missing = await patch({ first_response_sla_min: 20 });
    expect(missing.status).toBe(503);
    expect((await missing.json()).error).toMatch(/381/);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    queue("teams.select", [{ id: TEAM, first_response_sla_min: null }]);
    queue("teams.update", null, { code: "XX000" });
    const res = await patch({ first_response_sla_min: 20 });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/XX000/);
    err.mockRestore();
  });
});
