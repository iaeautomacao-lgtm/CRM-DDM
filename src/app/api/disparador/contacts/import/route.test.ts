import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  foreignDraftTable: "", draftError: false, failContact: false,
  calls: [] as { table: string; method: string; args: unknown[] }[],
}));
vi.mock("@/lib/disparador/route-auth", () => ({
  requireDisparadorAccess: async () => ({ accountId: "account-a", userId: "user-a" }),
}));
vi.mock("@/lib/disparador/blacklist-keys", () => ({ loadBlacklistKeySet: async () => new Set() }));
vi.mock("@/lib/logger", () => ({ writeLog: vi.fn() }));
vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      let foreignCheck = false;
      let inserted = false;
      for (const method of ["select", "eq", "neq", "in", "is", "not", "limit", "order", "range", "insert", "delete", "update", "upsert"]) {
        b[method] = (...args: unknown[]) => {
          state.calls.push({ table, method, args });
          if (method === "neq") foreignCheck = true;
          if (method === "insert") inserted = true;
          return b;
        };
      }
      const result = () => {
        if (foreignCheck) return {
          data: table === state.foreignDraftTable ? [{ id: "foreign" }] : [],
          error: state.draftError ? { message: "segredo do banco" } : null,
        };
        if (inserted && table === "contacts") return {
          data: state.failContact ? null : [{ id: "contact-1" }],
          error: state.failContact ? { message: "segredo do banco", code: "XX000" } : null,
        };
        return { data: [], error: null };
      };
      b.maybeSingle = async () => { const r = result(); return { ...r, data: r.data?.[0] ?? null }; };
      b.single = b.maybeSingle;
      b.then = (resolve: (value: unknown) => unknown) => resolve(result());
      return b;
    },
  }),
}));

import { POST } from "./route";

const DRAFT = "11111111-1111-4111-8111-111111111111";
const body = (overrides: Record<string, unknown> = {}) => ({
  rows: [{ nome: "Ana", telefone: "11999999999" }],
  draft_id: DRAFT, column_map: { name: "nome", phone: "telefone" },
  mapping_confirmed: true, chunk_index: 0, ...overrides,
});
const post = (value: unknown) => POST(new Request("https://crm.test/api", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
}));

describe("import: escopo do rascunho e preservação dos blocos", () => {
  beforeEach(() => {
    state.calls = []; state.foreignDraftTable = ""; state.draftError = false; state.failContact = false;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["campaigns", "disp_import_contacts", "disparador_utm_links", "contact_import_variables"])(
    "recusa draft_id já utilizado em outra conta (%s) sem escrever", async (table) => {
      state.foreignDraftTable = table;
      expect((await post(body())).status).toBe(404);
      expect(state.calls.some((c) => ["insert", "upsert", "delete", "update"].includes(c.method))).toBe(false);
      expect(state.calls.filter((c) => c.method === "neq").every((c) => c.args[1] === "account-a")).toBe(true);
    },
  );

  it("campanha fora da conta continua sendo recusada", async () => {
    expect((await post(body({ campaign_id: DRAFT }))).status).toBe(404);
    expect(state.calls).toContainEqual({ table: "campaigns", method: "eq", args: ["account_id", "account-a"] });
  });

  it("input inválido retorna 400 sem escrever", async () => {
    expect((await post(body({ draft_id: "inválido" }))).status).toBe(400);
    expect(state.calls).toEqual([]);
  });

  it("falha ao verificar posse fecha o acesso e não vaza erro", async () => {
    state.draftError = true;
    const res = await post(body());
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("segredo");
  });

  it("UUID novo aceita blocos: só chunk 0 limpa e o delete tem account_id", async () => {
    const first = await post(body());
    expect(first.status).toBe(200);
    expect((await first.json()).linked).toBe(1);
    expect(state.calls).toContainEqual({ table: "disp_import_contacts", method: "delete", args: [] });
    expect(state.calls).toContainEqual({ table: "disp_import_contacts", method: "eq", args: ["account_id", "account-a"] });
    state.calls = [];
    const next = await post(body({ chunk_index: 1 }));
    expect(next.status).toBe(200);
    expect((await next.json()).linked).toBe(1);
    expect(state.calls.some((c) => c.method === "delete")).toBe(false);
    expect(state.calls.some((c) => c.table === "disp_import_contacts" && c.method === "insert")).toBe(true);
  });

  it("falha parcial de insert não vaza a mensagem do banco em results.erros", async () => {
    state.failContact = true;
    const res = await post(body());
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.results.erros.join(" ")).toContain("não foi possível salvar");
    expect(JSON.stringify(result)).not.toContain("segredo");
  });
});
