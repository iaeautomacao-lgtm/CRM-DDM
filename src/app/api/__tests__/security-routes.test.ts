import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

const state = vi.hoisted(() => ({
  role: "admin", accountId: "account-a", userId: "user-a",
  rows: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as { table: string; method: string; args: unknown[] }[],
  analyze: vi.fn(), loadSteps: vi.fn(async () => []),
}));

function client() {
  return {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      for (const method of ["select", "eq", "neq", "in", "is", "not", "limit", "order", "or", "range", "ilike", "insert"]) {
        b[method] = (...args: unknown[]) => {
          state.calls.push({ table, method, args });
          return b;
        };
      }
      const result = () => ({ data: state.rows[table] ?? [], error: null });
      b.maybeSingle = async () => ({ data: result().data[0] ?? null, error: null });
      b.single = async () => ({ data: result().data[0] ?? { id: "created" }, error: null });
      b.then = (resolve: (value: unknown) => unknown) => resolve(result());
      return b;
    },
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  };
}

vi.mock("@/lib/auth/account", async () => {
  const { hasMinRole } = await import("@/lib/auth/roles");
  const perms = await import("@/lib/auth/permissions");
  class ForbiddenError extends Error { readonly status = 403; }
  const getCurrentAccount = async () => ({
    supabase: client(), accountId: state.accountId, userId: state.userId,
    role: state.role, permissions: perms.permissionsForRole(state.role as never),
    account: { id: state.accountId, name: "Conta" },
  });
  return {
    ForbiddenError, getCurrentAccount,
    requireRole: async (min: Parameters<typeof hasMinRole>[1]) => {
      if (!hasMinRole(state.role as Parameters<typeof hasMinRole>[0], min)) throw new ForbiddenError();
      return getCurrentAccount();
    },
    // Gate por permissão (PRD 20.3) com o catálogo real.
    requirePermission: async (permission: string) => {
      const ctx = await getCurrentAccount();
      if (!perms.can(ctx as never, permission as never)) throw new ForbiddenError();
      return ctx;
    },
    toErrorResponse: (err: unknown) => new Response(JSON.stringify({ error: "Falha" }), {
      status: err instanceof ForbiddenError ? 403 : 500,
    }),
  };
});
vi.mock("@/lib/automations/admin-client", () => ({ supabaseAdmin: client }));
vi.mock("@/lib/disparador/admin-client", () => ({ supabaseAdmin: client }));
vi.mock("@/lib/relatorios/admin-client", () => ({ supabaseAdmin: client }));
vi.mock("@/lib/automations/steps-tree", () => ({
  loadStepsTree: state.loadSteps, insertSteps: vi.fn(), replaceSteps: vi.fn(),
}));
vi.mock("@/lib/ai/sentiment", () => ({ analyzeConversationSentimentAndTags: state.analyze }));

import { GET as automations } from "../automations/route";
import { GET as automation } from "../automations/[id]/route";
import { POST as exportFile } from "../relatorios/exports/route";
import { GET as queue } from "../disparador/campaigns/[id]/queue-details/route";
import { POST as channelTest } from "../whatsapp/channel-test/route";
import { POST as sentiment } from "../conversations/[id]/sentiment/route";
import { POST as utm } from "../disparador/utm/route";
import { GET as metrics } from "../disparador/utm/metricas/route";

const params = { params: Promise.resolve({ id: "campaign-1" }) };
const post = (body: unknown) => new Request("https://crm.test/api", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const get = (query: string) => new Request(`https://crm.test/api?${query}`);

describe("segurança das rotas: contas, papéis e orçamentos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetRateLimitForTests();
    state.role = "admin"; state.accountId = "account-a"; state.userId = "user-a";
    state.rows = {}; state.calls = [];
    state.analyze.mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("agent consulta automações e detalhe; todas as leituras têm account_id", async () => {
    state.role = "agent";
    state.rows.automations = [{ id: "auto-1" }];
    expect((await automations()).status).toBe(200);
    expect((await automation(get(""), params)).status).toBe(200);
    expect(state.calls.filter((c) => c.method === "eq" && c.args[0] === "account_id")).toHaveLength(2);
    expect(state.loadSteps).toHaveBeenCalledOnce();
  });

  it.each(["xlsx", "csv", "CSV"])("export aceita %s com chave gerada pelo servidor", async (ext) => {
    const res = await exportFile(post({ exportType: "conversas", description: "x", fileName: `../a.${ext}`, fileBase64: "aGk=" }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.storage_path).toMatch(/^account-a\/[a-f0-9-]+\.(xlsx|csv)$/);
  });

  it("export recusa binário acima de 25 MB mesmo no limite da string base64", async () => {
    const res = await exportFile(post({
      exportType: "conversas", description: "x", fileName: "a.csv",
      fileBase64: Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64"),
    }));
    expect(res.status).toBe(413);
    expect(state.calls).toEqual([]);
  });

  it("fila trata % e _ como caracteres literais no .or()", async () => {
    state.rows.campaigns = [{ id: "campaign-1", account_id: "account-a" }];
    expect((await queue(get("status=total&search=100%25_"), params)).status).toBe(200);
    const filter = state.calls.find((c) => c.method === "or");
    expect(filter?.args[0]).toBe('name.ilike."%100\\\\%\\\\_%",phone.ilike."%100\\\\%\\\\_%"');
    expect(state.calls).toContainEqual({ table: "contact_import_variables", method: "ilike", args: ["value", "%100\\%\\_%"] });
  });

  it("termo composto só pela gramática do filtro não vira export de todos", async () => {
    state.rows.campaigns = [{ id: "campaign-1", account_id: "account-a" }];
    const res = await queue(get("status=total&search=%28%29%2C*"), params);
    expect(res.status).toBe(200);
    expect((await res.json()).rows).toEqual([]);
    expect(state.calls.some((c) => c.table === "contacts" || c.table === "disp_message_queue")).toBe(false);
  });

  it("padrão da rota busca % e _ literalmente no Postgres", async () => {
    state.rows.campaigns = [{ id: "campaign-1", account_id: "account-a" }];
    await queue(get("status=total&search=100%25_"), params);
    const pattern = state.calls.find((c) => c.method === "ilike")?.args[1];
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    try {
      const result = await db.query<{ name: string }>(
        "SELECT name FROM (VALUES ('100%_ literal'), ('100xyz')) AS names(name) WHERE name ILIKE $1",
        [pattern],
      );
      expect(result.rows).toEqual([{ name: "100%_ literal" }]);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("channel-test compartilha 10/min entre administradores da mesma conta", async () => {
    for (let i = 0; i < 10; i++) {
      state.userId = `user-${i}`;
      expect((await channelTest(post({}))).status).toBe(400);
    }
    const res = await channelTest(post({}));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    state.accountId = "account-b";
    expect((await channelTest(post({}))).status).toBe(400);
  });

  it("sentimento tem 10/min por usuário e valida a conta antes da IA", async () => {
    state.role = "agent";
    state.rows.conversations = [{ contact_id: "contact-1", sentiment: "neutral" }];
    for (let i = 0; i < 10; i++) expect((await sentiment(post({}), params)).status).toBe(200);
    expect((await sentiment(post({}), params)).status).toBe(429);
    expect(state.analyze).toHaveBeenCalledTimes(10);
    expect(state.analyze).toHaveBeenCalledWith("account-a", "contact-1", "campaign-1");
    state.userId = "user-b";
    state.rows.conversations = [];
    expect((await sentiment(post({}), params)).status).toBe(404);
    expect(state.analyze).toHaveBeenCalledTimes(10);
  });

  it("erro do provedor de sentimento não sai na resposta", async () => {
    state.rows.conversations = [{ contact_id: "contact-1" }];
    state.analyze.mockRejectedValueOnce(new Error("segredo do provedor"));
    const res = await sentiment(post({}), params);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("segredo");
  });

  it("UTM valida body antes de chamar o serviço externo", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    expect((await utm(post({ campanha: "Promo" }))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  // O nome da campanha vai sem prefixo ao serviço UTM (é o utm_campaign que
  // aparece no analytics e indexa o histórico); o isolamento entre contas é a
  // checagem de que a campanha pertence à conta antes de consultar métricas.
  it("métricas UTM só para campanha da própria conta; nome enviado sem prefixo", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const payload = { canal: "whatsapp", campanha: "Promo", url_destino: "https://example.com", alunos: ["1"] };
    expect((await utm(post(payload))).status).toBe(200);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).campanha).toBe("Promo");
    state.rows.campaigns = [{ id: "campaign-1" }];
    expect((await metrics(get("campanha=Promo"))).status).toBe(200);
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get("campanha")).toBe("Promo");
    state.rows.campaigns = [];
    expect((await metrics(get("campanha=Promo"))).status).toBe(404);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
