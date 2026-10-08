import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ account: vi.fn(), audit: vi.fn(), writes: [] as unknown[], tables: [] as string[] }));

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

const SESSION = "00000000-0000-0000-0000-0000000000d1";
vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      mocks.tables.push(table);
      const proxy: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "gte", "order", "limit"]) proxy[m] = () => proxy;
      proxy.update = (v: unknown) => {
        mocks.writes.push(v);
        return proxy;
      };
      proxy.insert = (v: unknown) => {
        mocks.writes.push(v);
        return proxy;
      };
      proxy.then = (resolve: (v: unknown) => unknown) => {
        let data: unknown = [];
        if (table === "whatsapp_config") data = [{ id: SESSION, phone_number: "5511", display_name: "Principal", provider: "meta", habilitado: true }];
        if (table === "dispatch_channel_limits") data = [{ session_id: SESSION, max_in_flight: 4, hourly_limit: null, paused: false }];
        return resolve({ data, error: null });
      };
      return proxy;
    },
  }),
}));

import { GET, PUT } from "./route";

const ACC = "00000000-0000-0000-0000-0000000000a1";
const ctx = (role: string) => ({ accountId: ACC, userId: "u1", role, supabase: {} });
const put = (body: unknown) => new Request("http://x/api/disparador/limits", { method: "PUT", body: JSON.stringify(body) });
const valid = { sessionId: SESSION, maxInFlight: 20, reason: "subir para o teste", confirm: true };

afterEach(() => {
  vi.clearAllMocks();
  mocks.writes.length = 0;
  mocks.tables.length = 0;
});

describe("/api/disparador/limits — papel", () => {
  it("papéis sem acesso ao disparador: 403 em GET e PUT, nada lido nem gravado", async () => {
    for (const role of ["agent", "viewer"]) {
      mocks.account.mockResolvedValue(ctx(role));
      expect((await GET()).status, role).toBe(403);
      expect((await PUT(put(valid))).status, role).toBe(403);
    }
    expect(mocks.tables).toHaveLength(0);
    expect(mocks.writes).toHaveLength(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("admin lê os números sem cache", async () => {
    mocks.account.mockResolvedValue(ctx("admin"));
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    const body = await res.json();
    expect(body.numbers[0]).toMatchObject({ id: SESSION, maxInFlight: 4, paused: false });
    expect(body.rate).toHaveProperty(SESSION);
  });
});

describe("PUT /api/disparador/limits", () => {
  it("grava, audita o antes → depois com o motivo e devolve o novo estado", async () => {
    mocks.account.mockResolvedValue(ctx("owner"));
    const res = await PUT(put(valid));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, changed: true, changes: [{ field: "max_in_flight", before: 4, after: 20 }] });
    expect(mocks.writes).toEqual([{ max_in_flight: 20 }]);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACC,
        resourceType: "dispatch_channel_limits",
        resourceId: SESSION,
        changes: { max_in_flight: { before: 4, after: 20 } },
        metadata: expect.objectContaining({ reason: "subir para o teste" }),
      }),
    );
  });

  it("sem motivo, sem confirmação ou fora da faixa: 400 e nada é gravado", async () => {
    mocks.account.mockResolvedValue(ctx("admin"));
    for (const body of [{ ...valid, reason: "" }, { ...valid, confirm: false }, { ...valid, maxInFlight: 151 }, { ...valid, hourlyLimit: 0 }, { sessionId: SESSION, reason: "motivo ok", confirm: true }]) {
      const res = await PUT(put(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(mocks.writes).toHaveLength(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("corpo que não é JSON: 400", async () => {
    mocks.account.mockResolvedValue(ctx("admin"));
    expect((await PUT(new Request("http://x", { method: "PUT", body: "{" }))).status).toBe(400);
  });

  it("sem mudança real: não grava nem audita", async () => {
    mocks.account.mockResolvedValue(ctx("admin"));
    const res = await PUT(put({ ...valid, maxInFlight: 4 }));
    expect(await res.json()).toMatchObject({ ok: true, changed: false });
    expect(mocks.writes).toHaveLength(0);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
