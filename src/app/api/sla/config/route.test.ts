import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  tables: {} as Record<string, { data?: unknown; error?: { code?: string } | null }>,
  eq: vi.fn(),
}));
vi.mock("@/lib/auth/account", () => ({
  requirePermission: mocks.requirePermission,
  toErrorResponse: (e: unknown) => new Response(JSON.stringify({ error: (e as Error).message }), { status: (e as { status?: number }).status ?? 500 }),
}));
vi.mock("@/lib/account/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "limit"]) b[m] = () => b;
      b.eq = (...a: unknown[]) => {
        mocks.eq(table, ...a);
        return b;
      };
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: mocks.tables[table]?.data ?? [], error: mocks.tables[table]?.error ?? null }).then(ok);
      return b;
    },
  }),
}));

import { GET } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({ accountId: "acc-1" });
  mocks.tables = {};
});

describe("GET /api/sla/config", () => {
  it("devolve o padrão efetivo, o valor próprio e o resolvido por equipe, só da conta de quem pede", async () => {
    mocks.tables = { account_settings: { data: [{ value: 20 }] }, teams: { data: [{ id: "t1", first_response_sla_min: 45 }, { id: "t2", first_response_sla_min: null }] } };
    const res = await GET();
    expect(mocks.requirePermission).toHaveBeenCalledWith("account.view");
    expect(await res.json()).toEqual({ default_min: 20, default_source: "account", fallback_min: 15, teams: { t1: 45, t2: null }, effective: { t1: 45, t2: 20 } });
    expect(mocks.eq).toHaveBeenCalledWith("teams", "account_id", "acc-1");
    expect(mocks.eq).toHaveBeenCalledWith("account_settings", "account_id", "acc-1");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });
  it("sem configuração (ou sem a 381): 15 para todos", async () => {
    mocks.tables = { teams: { error: { code: "42703" } } };
    expect(await (await GET()).json()).toEqual({ default_min: 15, default_source: "default", fallback_min: 15, teams: {}, effective: {} });
  });
  it("sem sessão/permissão: nada é lido", async () => {
    mocks.requirePermission.mockRejectedValue(Object.assign(new Error("negado"), { status: 403 }));
    expect((await GET()).status).toBe(403);
    expect(mocks.eq).not.toHaveBeenCalled();
  });
});
