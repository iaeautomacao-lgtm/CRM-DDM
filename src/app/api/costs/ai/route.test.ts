import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  rpc: vi.fn(),
  rates: vi.fn(),
  eq: vi.fn(),
}));
vi.mock("@/lib/auth/account", () => ({
  requirePermission: mocks.requirePermission,
  toErrorResponse: (e: unknown) => new Response(JSON.stringify({ error: (e as Error).message }), { status: (e as { status?: number }).status ?? 500 }),
}));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    rpc: mocks.rpc,
    from: () => {
      const b: Record<string, unknown> = {};
      for (const m of ["select", "order", "limit"]) b[m] = () => b;
      b.eq = (...a: unknown[]) => {
        mocks.eq(...a);
        return b;
      };
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve(mocks.rates()).then(ok);
      return b;
    },
  }),
}));

import { GET } from "./route";

const req = (qs = "") => new Request(`http://x/api/costs/ai${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePermission.mockResolvedValue({ accountId: "acc-1" });
  mocks.rpc.mockResolvedValue({ data: { ai: [{ sku: "openai:gpt-4o-mini", requests: 2, input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, priced_usd: 1.5, unpriced: 0 }] }, error: null });
  mocks.rates.mockReturnValue({ data: [], error: null });
});

describe("GET /api/costs/ai", () => {
  it("exige a permissão e consulta SÓ a conta de quem pede", async () => {
    const res = await GET(req("?month=2026-10"));
    expect(mocks.requirePermission).toHaveBeenCalledWith("reports.view_all");
    expect(mocks.rpc).toHaveBeenCalledWith("get_monthly_ai_cost_report", { p_account_id: "acc-1", p_month: "2026-10-01" });
    expect(mocks.eq).toHaveBeenCalledWith("account_id", "acc-1");
    const body = await res.json();
    expect(body).toMatchObject({ month: "2026-10", estimate: true, currency: "USD" });
    expect(body.notice).toMatch(/estimad/i);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });
  it("sem permissão: nada é lido", async () => {
    mocks.requirePermission.mockRejectedValue(Object.assign(new Error("negado"), { status: 403 }));
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("mês inválido = 400", async () => {
    expect((await GET(req("?month=2026-13"))).status).toBe(400);
    expect((await GET(req("?month=abc"))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("migration ausente = 503; outro erro = 500 sem vazar detalhe", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "função" } });
    expect((await GET(req())).status).toBe(503);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "detalhe interno" } });
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/interno/);
    err.mockRestore();
  });
  it("CSV", async () => {
    const res = await GET(req("?month=2026-10&format=csv"));
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toContain("custos-ia-2026-10.csv");
  });
});
