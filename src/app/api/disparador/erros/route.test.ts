import { afterEach, describe, expect, it, vi } from "vitest";
import { assertRowColumns } from "@/test/db-columns";

const mocks = vi.hoisted(() => ({ account: vi.fn(), audit: vi.fn(), tables: [] as string[] }));

vi.mock("@/lib/auth/account", () => {
  class ForbiddenError extends Error {
    readonly status = 403;
  }
  return {
    ForbiddenError,
    getCurrentAccount: mocks.account,
    toErrorResponse: (err: unknown) =>
      new Response(JSON.stringify({ error: String(err) }), { status: (err as { status?: number })?.status ?? 500 }),
  };
});
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: mocks.audit }));
vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      mocks.tables.push(table);
      const proxy: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "not", "gte", "or", "order", "limit"]) proxy[m] = () => proxy;
      proxy.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: table === "whatsapp_config" ? assertRowColumns("whatsapp_config", [{ id: "s1", display_phone_number: "5511", waha_session: null, provider: "meta", habilitado: true }]) : [], error: null });
      return proxy;
    },
    rpc: async () => ({ data: { codes: [], total: 0, truncated: false }, error: null }),
  }),
}));

import { GET } from "./route";
import { GET as GET_DETAIL } from "./[id]/route";

const ACC = "00000000-0000-0000-0000-0000000000a1";
const ITEM = "00000000-0000-0000-0000-0000000000e1";
const ctx = (role: string) => ({ accountId: ACC, userId: "u1", role, supabase: {} });
const req = (qs = "") => new Request(`http://x/api/disparador/erros${qs}`);

afterEach(() => {
  vi.clearAllMocks();
  mocks.tables.length = 0;
});

describe("GET /api/disparador/erros — papel e conta", () => {
  it("papéis sem acesso ao disparador recebem 403 e nada é lido", async () => {
    for (const role of ["agent", "viewer"]) {
      mocks.account.mockResolvedValue(ctx(role));
      expect((await GET(req())).status, role).toBe(403);
      const d = await GET_DETAIL(req(), { params: Promise.resolve({ id: ITEM }) });
      expect(d.status, role).toBe(403);
    }
    expect(mocks.tables).toHaveLength(0);
  });

  it("admin lista (com resumo) sem cache", async () => {
    mocks.account.mockResolvedValue(ctx("admin"));
    const res = await GET(req("?summary=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(await res.json()).toMatchObject({ ok: true, items: [], nextCursor: null, summary: { total: 0, source: "rpc" } });
  });

  it("filtro ou cursor inválido: 400", async () => {
    mocks.account.mockResolvedValue(ctx("owner"));
    expect((await GET(req("?code=abc"))).status).toBe(400);
    expect((await GET(req("?cursor=zzz"))).status).toBe(400);
  });

  it("CSV: entrega arquivo e audita a exportação na conta da sessão", async () => {
    mocks.account.mockResolvedValue(ctx("admin"));
    const res = await GET(req("?format=csv"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ accountId: ACC, action: "disparador.errors_exported" }));
  });

  it("detalhe de item inexistente: 404", async () => {
    mocks.account.mockResolvedValue(ctx("admin"));
    const res = await GET_DETAIL(req(), { params: Promise.resolve({ id: ITEM }) });
    expect(res.status).toBe(404);
  });
});
