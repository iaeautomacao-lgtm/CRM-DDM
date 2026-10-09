import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/whatsapp/encryption", () => ({ encrypt: (s: string) => `enc:${s}`, decrypt: (s: string) => s.slice(4) }));
const assertPublicUrl = vi.fn(async (u: string) => new URL(u));
vi.mock("@/lib/security/ssrf-guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/security/ssrf-guard")>()),
  assertPublicUrl: (...a: unknown[]) => (assertPublicUrl as unknown as (...x: unknown[]) => unknown)(...a),
}));

const { SsrfBlockedError } = await import("@/lib/security/ssrf-guard");
const { createEndpoint, deleteEndpoint, enqueueTest, getEndpoint, listDeliveries, listEndpoints, parseDeliveryCursor, replayDelivery, rotateSecret, updateEndpoint } =
  await import("./endpoints");

type Call = { table: string; op: string; payload?: unknown; filters: Record<string, unknown>; select?: string };
let calls: Call[] = [];
let results: Record<string, { data?: unknown; error?: { code?: string; message?: string } | null; count?: number }> = {};
let rpcResult: { data: unknown; error: { code?: string; message?: string } | null } = { data: true, error: null };

function fakeDb() {
  return {
    rpc: vi.fn(async () => rpcResult),
    from: (table: string) => {
      const call: Call = { table, op: "select", filters: {} };
      calls.push(call);
      const b: Record<string, unknown> = {};
      b.select = (cols?: string) => ((call.select ??= cols), b);
      b.insert = (payload: unknown) => ((call.op = "insert"), (call.payload = payload), b);
      b.update = (payload: unknown) => ((call.op = "update"), (call.payload = payload), b);
      b.delete = () => ((call.op = "delete"), b);
      for (const m of ["eq", "order", "limit", "or"]) b[m] = (...args: unknown[]) => ((call.filters[`${m}:${String(args[0])}`] = args[1] ?? true), b);
      b.then = (resolve: (v: unknown) => void) => {
        const r = results[`${table}:${call.op}`] ?? { data: [], error: null };
        resolve({ data: r.data ?? [], error: r.error ?? null, count: r.count ?? 0 });
      };
      return b;
    },
  };
}
const db = () => fakeDb() as never;
const view = { id: "11111111-1111-4111-8111-111111111111", url: "https://x.example/h", description: null, events: ["message.received"], status: "active", consecutive_failures: 0, last_success_at: null, last_failure_at: null, created_at: "2026-10-09T00:00:00Z" };

beforeEach(() => {
  calls = [];
  results = {};
  rpcResult = { data: true, error: null };
  assertPublicUrl.mockClear();
  assertPublicUrl.mockImplementation(async (u: string) => new URL(u));
});

describe("createEndpoint", () => {
  it("valida, cifra o segredo, devolve-o uma vez e nunca grava em claro", async () => {
    results["webhook_endpoints:select"] = { count: 0 };
    results["webhook_endpoints:insert"] = { data: [view] };
    const out = await createEndpoint(db(), { accountId: "A", keyId: "K1", url: "https://x.example/h", events: ["message.received", "message.received"], description: "ERP" });
    expect(out.secret).toMatch(/^whsec_/);
    expect(out).toMatchObject({ id: view.id, url: view.url });
    const insert = calls.find((c) => c.op === "insert")!;
    const payload = insert.payload as Record<string, unknown>;
    expect(payload).toMatchObject({ account_id: "A", created_by_key: "K1", events: ["message.received"], description: "ERP" });
    expect(payload.secret_enc).toBe(`enc:${out.secret}`);
    expect(JSON.stringify(payload)).not.toContain(`"secret":`);
    expect(insert.select).not.toMatch(/secret/); // o select de retorno não traz o segredo cifrado
  });

  it.each([
    ["sem url", { events: ["message.received"] }, /url/],
    ["http", { url: "http://x.example/h", events: ["message.received"] }, /https/],
    ["evento desconhecido", { url: "https://x.example/h", events: ["inventado"] }, /events/],
    ["sem eventos", { url: "https://x.example/h", events: [] }, /events/],
    ["descrição enorme", { url: "https://x.example/h", events: ["message.received"], description: "x".repeat(201) }, /description/],
  ] as Array<[string, Record<string, unknown>, RegExp]>)("400: %s", async (_n, body, message) => {
    await expect(createEndpoint(db(), { accountId: "A", keyId: null, url: undefined, events: undefined, ...body })).rejects.toMatchObject({ status: 400, code: "bad_request", message: expect.stringMatching(message) });
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("URL interna é recusada pelo SSRF-guard (sem expor o IP)", async () => {
    assertPublicUrl.mockRejectedValueOnce(new SsrfBlockedError("blocked_ip"));
    await expect(createEndpoint(db(), { accountId: "A", keyId: null, url: "https://interno.example/h", events: ["message.received"] })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("blocked_ip"),
    });
  });

  it("limite de 10 endpoints por conta → 409", async () => {
    results["webhook_endpoints:select"] = { count: 10 };
    await expect(createEndpoint(db(), { accountId: "A", keyId: null, url: "https://x.example/h", events: ["message.received"] })).rejects.toMatchObject({ status: 409, code: "conflict" });
  });

  it("migration 204 ausente → 503 unavailable (não 500)", async () => {
    results["webhook_endpoints:select"] = { error: { code: "42P01", message: 'relation "wacrm.webhook_endpoints" does not exist' } };
    await expect(createEndpoint(db(), { accountId: "A", keyId: null, url: "https://x.example/h", events: ["message.received"] })).rejects.toMatchObject({ status: 503, code: "unavailable" });
  });
});

describe("leitura, alteração e exclusão (sempre escopadas pela conta)", () => {
  it("list/get nunca selecionam o segredo e filtram por conta", async () => {
    results["webhook_endpoints:select"] = { data: [view] };
    await listEndpoints(db(), "A");
    await getEndpoint(db(), "A", view.id);
    for (const c of calls) {
      expect(c.select).not.toMatch(/secret/);
      expect(c.filters["eq:account_id"]).toBe("A");
    }
  });

  it("get de outra conta/inexistente → 404", async () => {
    results["webhook_endpoints:select"] = { data: [] };
    await expect(getEndpoint(db(), "A", view.id)).rejects.toMatchObject({ status: 404, code: "not_found" });
  });

  it("update valida cada campo e recusa corpo vazio; status só active|paused", async () => {
    results["webhook_endpoints:select"] = { data: [view] };
    results["webhook_endpoints:update"] = { data: [{ ...view, status: "paused" }] };
    await expect(updateEndpoint(db(), "A", view.id, {})).rejects.toMatchObject({ status: 400 });
    await expect(updateEndpoint(db(), "A", view.id, { status: "disabled" })).rejects.toMatchObject({ status: 400 });
    await expect(updateEndpoint(db(), "A", view.id, { url: "http://x" })).rejects.toMatchObject({ status: 400 });
    const out = await updateEndpoint(db(), "A", view.id, { status: "paused" });
    expect(out.status).toBe("paused");
    const update = calls.filter((c) => c.op === "update").pop()!;
    expect(update.filters["eq:account_id"]).toBe("A");
    expect(update.filters["eq:id"]).toBe(view.id);
  });

  it("delete e rotate-secret escopam por conta; rotate cifra o novo e devolve em claro uma vez", async () => {
    results["webhook_endpoints:select"] = { data: [view] };
    await deleteEndpoint(db(), "A", view.id);
    expect(calls.find((c) => c.op === "delete")!.filters["eq:account_id"]).toBe("A");
    const { secret } = await rotateSecret(db(), "A", view.id);
    expect(secret).toMatch(/^whsec_/);
    const update = calls.filter((c) => c.op === "update").pop()!;
    expect((update.payload as { secret_enc: string }).secret_enc).toBe(`enc:${secret}`);
  });
});

describe("entregas", () => {
  it("lista com keyset, estado válido e next_cursor opaco", async () => {
    results["webhook_endpoints:select"] = { data: [view] };
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, created_at: `2026-10-09T10:00:0${3 - i}.000Z`, event: "message.received", state: "dead" }));
    results["webhook_deliveries:select"] = { data: rows };
    const page = await listDeliveries(db(), "A", view.id, { state: "dead", limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(parseDeliveryCursor(page.next_cursor)).toEqual({ created_at: rows[1].created_at, id: rows[1].id });
    const q = calls.find((c) => c.table === "webhook_deliveries")!;
    expect(q.filters).toMatchObject({ "eq:account_id": "A", "eq:endpoint_id": view.id, "eq:state": "dead" });
    expect(q.select).not.toMatch(/payload|secret/); // nunca devolve o corpo
  });

  it("estado ou cursor inválidos → 400", async () => {
    results["webhook_endpoints:select"] = { data: [view] };
    await expect(listDeliveries(db(), "A", view.id, { state: "x" })).rejects.toMatchObject({ status: 400 });
    await expect(listDeliveries(db(), "A", view.id, { cursor: "lixo" })).rejects.toMatchObject({ status: 400 });
    expect(parseDeliveryCursor(Buffer.from(JSON.stringify({ c: "nao-data", i: "x" })).toString("base64url"))).toBeNull();
  });

  it("replay: só dead (RPC devolve false → 409)", async () => {
    results["webhook_endpoints:select"] = { data: [view] };
    await expect(replayDelivery(db(), "A", view.id, "d1")).resolves.toBeUndefined();
    rpcResult = { data: false, error: null };
    await expect(replayDelivery(db(), "A", view.id, "d1")).rejects.toMatchObject({ status: 409, code: "conflict" });
  });

  it("teste: enfileira webhook.test só para o endpoint, sem dados reais", async () => {
    results["webhook_endpoints:select"] = { data: [view] };
    results["webhook_deliveries:insert"] = { data: [{ id: "del-1" }] };
    expect(await enqueueTest(db(), "A", view.id)).toEqual({ delivery_id: "del-1" });
    const payload = (calls.find((c) => c.op === "insert")!.payload as { event: string; payload: { type: string; data: Record<string, unknown> } });
    expect(payload.event).toBe("webhook.test");
    expect(payload.payload.type).toBe("webhook.test");
    expect(Object.keys(payload.payload.data)).toEqual(["message"]);
  });
});
