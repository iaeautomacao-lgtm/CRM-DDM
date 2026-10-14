import { beforeEach, describe, expect, it, vi } from "vitest";

// Leituras do funil UTMpay: funil da campanha, ranking, selo por conversa e por contato (permissão, escopo e formato do contrato).
const state = vi.hoisted(() => ({
  perm: true,
  guarded: [] as string[],
  disparador: true,
  campaign: { id: "11111111-1111-4111-8111-111111111111" } as Record<string, unknown> | null,
  conversation: { id: "conv-1", contact_id: "c1" } as Record<string, unknown> | null,
  contact: { id: "c1" } as Record<string, unknown> | null,
  funnelRpc: { data: null as unknown, error: null as null | { code: string } },
  badge: null as unknown,
  rpcArgs: null as unknown,
}));

vi.mock("@/lib/disparador/route-auth", () => ({
  requireDisparadorAccess: async () => {
    if (!state.disparador) throw Object.assign(new Error("forbidden"), { status: 403 });
    return { accountId: "acc-1", userId: "u1" };
  },
}));
vi.mock("@/lib/auth/account", () => ({ toErrorResponse: () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }) }));
vi.mock("@/lib/disparador/admin-client", () => ({
  supabaseAdmin: () => ({
    rpc: async (_name: string, args: unknown) => ((state.rpcArgs = args), state.funnelRpc),
    from: (t: string) =>
      t === "profiles"
        ? { select: () => ({ in: async () => ({ data: [{ user_id: "att-1", full_name: "Ana" }] }) }) }
        : { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.campaign }) }) }) }) },
  }),
}));
vi.mock("@/lib/disparador/campaign-status-counts", () => ({ loadCampaignStatusCounts: async () => ({ entregue: 60, lido: 40, enviado: 10 }) }));
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({
    rpc: async (_name: string, args: unknown) => ((state.rpcArgs = args), state.funnelRpc),
    from: () => ({ select: () => ({ in: async () => ({ data: [{ user_id: "att-1", full_name: "Ana" }] }) }) }),
  }),
}));
vi.mock("@/lib/auth/route-guard", () => ({
  guardPermission: async (p: string) => {
    state.guarded.push(p);
    return state.perm
      ? {
          ok: true,
          ctx: {
            accountId: "acc-1",
            userId: "u1",
            supabase: { from: (t: string) => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: t === "conversations" ? state.conversation : state.contact, error: null }) }) }) }) }) },
          },
        }
      : { ok: false, response: new Response("{}", { status: 403 }) };
  },
}));
vi.mock("@/lib/utmpay/config", () => ({ loadUtmpayConfig: async () => ({ enabled: true }) }));
vi.mock("@/lib/utmpay/stats", async (orig) => {
  const real = await orig<typeof import("@/lib/utmpay/stats")>();
  return { ...real, loadContactBadge: vi.fn(async () => state.badge) };
});

import { loadContactBadge } from "@/lib/utmpay/stats";
import { GET as funil } from "../disparador/campaigns/[id]/funil/route";
import { GET as ranking } from "./ranking/route";
import { GET as conversationBadge } from "../conversations/[id]/utmpay/route";
import { GET as contactBadge } from "../contacts/[id]/utmpay/route";

const CAMP = "11111111-1111-4111-8111-111111111111";
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const stats = {
  links: 100, clicou: 40, fechou: 10, pagou: 5,
  por_atribuicao: { fechou: { ia: 4, humano: 6 }, pagou: { humano: 5 } },
  por_atendente: [{ atendente_id: "att-1", fechou: 6, pagou: 5 }],
};

beforeEach(() => {
  state.perm = true;
  state.guarded = [];
  state.disparador = true;
  state.campaign = { id: CAMP };
  state.conversation = { id: "conv-1", contact_id: "c1" };
  state.contact = { id: "c1" };
  state.funnelRpc = { data: stats, error: null };
  state.badge = null;
  vi.clearAllMocks();
});

describe("GET /api/disparador/campaigns/[id]/funil", () => {
  it("devolve o contrato: contagens, taxas ÷ entregues (entregue + lido), atribuição e ranking com nome", async () => {
    const res = await funil(new Request("https://crm.test/x"), params(CAMP));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ available: true, tracking: true, entregues: 100, links: 100, clicou: 40, fechou: 10, pagou: 5 });
    expect(body.taxas).toEqual({ clicou: 0.4, fechou: 0.1, pagou: 0.05 });
    expect(body.por_atribuicao).toEqual({ fechou: { direto: 0, ia: 4, humano: 6 }, pagou: { direto: 0, ia: 0, humano: 5 } });
    expect(body.por_atendente).toEqual([{ atendente_id: "att-1", atendente_nome: "Ana", fechou: 6, pagou: 5 }]);
  });
  it("sem a migration 356: available:false com zeros; campanha de outra conta: 404; id inválido: 404; sem papel: 403", async () => {
    state.funnelRpc = { data: null, error: { code: "42883" } };
    expect(await (await funil(new Request("https://crm.test/x"), params(CAMP))).json()).toMatchObject({ available: false, clicou: 0, fechou: 0, pagou: 0 });
    state.campaign = null;
    expect((await funil(new Request("https://crm.test/x"), params(CAMP))).status).toBe(404);
    expect((await funil(new Request("https://crm.test/x"), params("nao-uuid"))).status).toBe(404);
    state.disparador = false;
    expect((await funil(new Request("https://crm.test/x"), params(CAMP))).status).toBe(403);
  });
});

describe("GET /api/utmpay/ranking", () => {
  it("exige campaigns.view; período 1–365 (padrão 30) e só fechou/pagou/atribuição/atendentes", async () => {
    const res = await ranking(new Request("https://crm.test/x?dias=7"));
    expect(state.guarded).toEqual(["campaigns.view"]);
    expect(await res.json()).toMatchObject({ available: true, dias: 7, fechou: 10, pagou: 5, por_atendente: [{ atendente_nome: "Ana" }] });
    expect((await (await ranking(new Request("https://crm.test/x?dias=9999"))).json()).dias).toBe(30);
    expect((state.rpcArgs as { p_campaign: unknown; p_since: string }).p_campaign).toBeNull();
    expect(typeof (state.rpcArgs as { p_since: string }).p_since).toBe("string");
  });
  it("sem migration: available:false; sem permissão: 403", async () => {
    state.funnelRpc = { data: null, error: { code: "42883" } };
    expect(await (await ranking(new Request("https://crm.test/x"))).json()).toMatchObject({ available: false, fechou: 0, por_atendente: [] });
    state.perm = false;
    expect((await ranking(new Request("https://crm.test/x"))).status).toBe(403);
  });
});

describe("selo por conversa e por contato", () => {
  const badge = { campanha: "Setembro", enviado_em: "2026-10-01T10:00:00Z", clicou_em: "2026-10-01T11:00:00Z", fechou_em: null, pagou_em: null, atribuicao: null, atendente_nome: null, situacao_acordo: null, valor_em_aberto: null, instituicao: null, verificado_em: null };

  it("conversa: exige inbox.view, lê a conversa com a sessão do usuário e devolve { rastreio }", async () => {
    state.badge = badge;
    const res = await conversationBadge(new Request("https://crm.test/x"), params("conv-1"));
    expect(state.guarded).toEqual(["inbox.view"]);
    expect(await res.json()).toEqual({ rastreio: badge });
    expect(loadContactBadge).toHaveBeenCalledWith(expect.anything(), "acc-1", "c1");
  });
  it("conversa fora do escopo (RLS devolve nada): 404, sem consultar o rastreio; contato sem rastreio: { rastreio: null }", async () => {
    state.conversation = null;
    expect((await conversationBadge(new Request("https://crm.test/x"), params("conv-9"))).status).toBe(404);
    expect(loadContactBadge).not.toHaveBeenCalled();
    state.conversation = { id: "conv-1", contact_id: null };
    expect(await (await conversationBadge(new Request("https://crm.test/x"), params("conv-1"))).json()).toEqual({ rastreio: null });
  });
  it("contato: exige contacts.view, mesmo formato; contato de outra conta: 404; sem rastreio: null", async () => {
    state.badge = badge;
    expect(await (await contactBadge(new Request("https://crm.test/x"), params("c1"))).json()).toEqual({ rastreio: badge });
    expect(state.guarded).toContain("contacts.view");
    state.badge = null;
    expect(await (await contactBadge(new Request("https://crm.test/x"), params("c1"))).json()).toEqual({ rastreio: null });
    state.contact = null;
    expect((await contactBadge(new Request("https://crm.test/x"), params("c9"))).status).toBe(404);
  });
  it("sem permissão: 403 nas duas", async () => {
    state.perm = false;
    expect((await conversationBadge(new Request("https://crm.test/x"), params("conv-1"))).status).toBe(403);
    expect((await contactBadge(new Request("https://crm.test/x"), params("c1"))).status).toBe(403);
  });
});
