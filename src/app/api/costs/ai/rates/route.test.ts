import { beforeEach, describe, expect, it, vi } from "vitest";

type Result = { data?: unknown; error?: { code?: string } | null };
const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(),
  audit: vi.fn(async (_p: unknown) => undefined),
  results: [] as Array<{ table: string; op: string; result: { data?: unknown; error?: { code?: string } | null } }>,
  calls: [] as Array<{ table: string; op: string; payload?: unknown; filters: unknown[][] }>,
}));
vi.mock("@/lib/auth/account", () => ({
  requirePermission: mocks.requirePermission,
  toErrorResponse: (e: unknown) => new Response(JSON.stringify({ error: (e as Error).message }), { status: (e as { status?: number }).status ?? 500 }),
}));
vi.mock("@/lib/audit/log-event", () => ({ logAuditEvent: mocks.audit }));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const call = { table, op: "select", payload: undefined as unknown, filters: [] as unknown[][] };
      mocks.calls.push(call);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "order", "limit", "gte"]) b[m] = () => b;
      b.eq = (...a: unknown[]) => { call.filters.push(a); return b; };
      b.insert = (p: unknown) => { call.op = "insert"; call.payload = p; return b; };
      b.update = (p: unknown) => { call.op = "update"; call.payload = p; return b; };
      b.then = (ok: (v: unknown) => unknown) => {
        const i = mocks.results.findIndex((r) => r.table === table && (r.op === call.op));
        const r: Result = i >= 0 ? mocks.results.splice(i, 1)[0].result : { data: [], error: null };
        return Promise.resolve({ data: r.data ?? [], error: r.error ?? null }).then(ok);
      };
      return b;
    },
  }),
}));

import { GET, PUT } from "./route";

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
const put = (body: unknown) => PUT(new Request("http://x/api/costs/ai/rates", { method: "PUT", body: JSON.stringify(body) }));
const good = { sku: "openai:gpt-4o-mini", effective_from: future, input_per_million: 0.15, cached_input_per_million: null, output_per_million: 0.6 };
const saved = { id: "r1", sku: good.sku, effective_from: future, input_per_million: 0.15, cached_input_per_million: null, output_per_million: 0.6 };
const queue = (table: string, op: string, data: unknown, error: Result["error"] = null) => mocks.results.push({ table, op, result: { data, error } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.results.length = 0;
  mocks.calls.length = 0;
  mocks.requirePermission.mockResolvedValue({ accountId: "acc-1" });
});

describe("GET /api/costs/ai/rates", () => {
  it("lista as vigências (locked quando já começou) e os modelos já vistos, só da conta", async () => {
    queue("cost_rates", "select", [
      { sku: "openai:gpt-4o-mini", effective_from: future, input_per_million: "0.15", cached_input_per_million: null, output_per_million: "0.6" },
      { sku: "openai:gpt-4o-mini", effective_from: "2026-01-01", input_per_million: 1, cached_input_per_million: 0.5, output_per_million: 2 },
    ]);
    queue("ai_token_usage", "select", [{ provider: "claude", model: "sonnet" }, { provider: "openai", model: "gpt-4o-mini" }]);
    const res = await GET();
    expect(mocks.requirePermission).toHaveBeenCalledWith("reports.view_all");
    const body = await res.json();
    expect(body.rates.map((r: { locked: boolean }) => r.locked)).toEqual([false, true]);
    expect(body.rates[0]).toMatchObject({ currency: "USD", input_per_million: 0.15, cached_input_per_million: null });
    expect(body.skus).toEqual(["claude:sonnet", "openai:gpt-4o-mini"]);
    expect(mocks.calls.every((c) => c.filters.some((f) => f[0] === "account_id" && f[1] === "acc-1"))).toBe(true);
  });
  it("sem permissão: nada é lido", async () => {
    mocks.requirePermission.mockRejectedValue(Object.assign(new Error("negado"), { status: 403 }));
    expect((await GET()).status).toBe(403);
    expect(mocks.calls).toHaveLength(0);
  });
  it("sem a migration = 503", async () => {
    queue("cost_rates", "select", null, { code: "42P01" });
    expect((await GET()).status).toBe(503);
  });
});

describe("PUT /api/costs/ai/rates", () => {
  it("exige settings.account (admin/owner) e nada é gravado sem ela", async () => {
    mocks.requirePermission.mockRejectedValue(Object.assign(new Error("negado"), { status: 403 }));
    expect((await put(good)).status).toBe(403);
    expect(mocks.requirePermission).toHaveBeenCalledWith("settings.account");
    expect(mocks.calls).toHaveLength(0);
  });
  it("valida modelo, data, valores e passado (400 em pt-br)", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...good, sku: "gpt-4o" }, /Modelo inválido/],
      [{ ...good, sku: "openai:" + "x".repeat(120) }, /Modelo inválido/],
      [{ ...good, effective_from: "2026-02-30" }, /Data de vigência inválida/],
      [{ ...good, effective_from: "ontem" }, /Data de vigência inválida/],
      [{ ...good, effective_from: "2020-01-01" }, /não pode começar antes do mês atual/],
      [{ ...good, input_per_million: -1 }, /números de 0 a/],
      [{ ...good, output_per_million: "2" }, /números de 0 a/],
      [{ ...good, cached_input_per_million: 1e9 }, /números de 0 a/],
    ];
    for (const [body, msg] of cases) {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(msg);
    }
    expect(mocks.calls).toHaveLength(0);
    expect((await PUT(new Request("http://x", { method: "PUT", body: "nao-json" }))).status).toBe(400);
  });
  it("cria a vigência nova, com a conta de quem pede, e audita só sku/data/valores", async () => {
    queue("cost_rates", "select", []);
    queue("cost_rates", "insert", [saved]);
    const res = await put({ ...good, sku: " OpenAI:GPT-4o-mini " });
    expect(res.status).toBe(200);
    expect((await res.json()).rate).toMatchObject({ sku: "openai:gpt-4o-mini", currency: "USD", effective_from: future, locked: false });
    const insert = mocks.calls.find((c) => c.op === "insert")!;
    expect(insert.payload).toMatchObject({ account_id: "acc-1", source: "ai", currency: "USD", sku: "openai:gpt-4o-mini", input_per_million: 0.15, output_per_million: 0.6 });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0][0]).toMatchObject({
      accountId: "acc-1", eventType: "created", resourceType: "cost_rate", resourceId: "r1", action: "cost_rate.saved",
      metadata: { sku: "openai:gpt-4o-mini", effective_from: future, input_per_million: 0.15, cached_input_per_million: null, output_per_million: 0.6 },
    });
  });
  it("vigência futura existente é atualizada; a que já começou é imutável (409)", async () => {
    queue("cost_rates", "select", [{ id: "r1", effective_from: future }]);
    queue("cost_rates", "update", [saved]);
    expect((await put(good)).status).toBe(200);
    expect(mocks.calls.some((c) => c.op === "update")).toBe(true);
    expect(mocks.audit.mock.calls[0][0]).toMatchObject({ eventType: "updated" });

    mocks.calls.length = 0;
    mocks.audit.mockClear();
    queue("cost_rates", "select", [{ id: "r2", effective_from: today }]);
    const res = await put({ ...good, effective_from: today });
    expect(res.status).toBe(409);
    expect(mocks.calls.some((c) => c.op === "update" || c.op === "insert")).toBe(false);
    expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("B2 (revisão 16/10): tarifa nova com data de hoje ou do passado NÃO reprecifica o consumo quando o modelo já tem tarifa em vigor (409)", async () => {
    const monthStart = `${today.slice(0, 7)}-01`;
    for (const date of [today, monthStart]) {
      mocks.calls.length = 0;
      queue("cost_rates", "select", [{ id: "old", effective_from: "2026-01-01" }]); // tarifa em vigor (começou antes)
      const res = await put({ ...good, effective_from: date });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toMatch(/já tem uma tarifa em vigor/);
      expect(mocks.calls.some((c) => c.op === "insert" || c.op === "update")).toBe(false);
    }
    expect(mocks.audit).not.toHaveBeenCalled();
    // com tarifa em vigor, vigência FUTURA continua valendo
    queue("cost_rates", "select", [{ id: "old", effective_from: "2026-01-01" }]);
    queue("cost_rates", "insert", [saved]);
    expect((await put(good)).status).toBe(200);
  });
  it("B2: sem tarifa em vigor (primeira, ou só futuras) pode retroagir dentro do mês atual — o passado estava 'sem preço'", async () => {
    const monthStart = `${today.slice(0, 7)}-01`;
    queue("cost_rates", "select", []);
    queue("cost_rates", "insert", [{ ...saved, effective_from: monthStart }]);
    expect((await put({ ...good, effective_from: monthStart })).status).toBe(200);
    queue("cost_rates", "select", [{ id: "fut", effective_from: future }]); // só tarifa futura
    queue("cost_rates", "insert", [{ ...saved, effective_from: monthStart }]);
    expect((await put({ ...good, effective_from: monthStart })).status).toBe(200);
  });
  it("corrida na unicidade = 409; migration ausente = 503; erro do banco = 500 sem detalhe", async () => {
    queue("cost_rates", "select", []);
    queue("cost_rates", "insert", null, { code: "23505" });
    expect((await put(good)).status).toBe(409);
    queue("cost_rates", "select", null, { code: "42P01" });
    expect((await put(good)).status).toBe(503);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    queue("cost_rates", "select", []);
    queue("cost_rates", "insert", null, { code: "XX000" });
    const res = await put(good);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/XX000/);
    err.mockRestore();
  });
});
