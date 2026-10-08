import { describe, expect, it, vi } from "vitest";
import { applyRealReadPolicy } from "./parse";
import { savedCatalogToolNames, simulatedToolFetch } from "./ai";
import type { SimContext } from "./context";

function ctx(realReadOnlyTools: string[], realFetch = vi.fn()): SimContext {
  return {
    accountId: "a",
    conversationId: "c",
    provider: "waha",
    db: {} as never,
    tables: {} as never,
    clock: { last: 0 },
    outbound: [],
    notes: [],
    toolMocks: {},
    realReadOnlyTools,
    httpMocks: {},
    realFetch,
    seq: { value: 0 },
  } as unknown as SimContext;
}

const real = (over: Record<string, unknown> = {}) => async () => ({
  url: "https://api.exemplo.com/x?tk=SEGREDO-123456",
  init: { method: "GET" },
  credentialInjected: true,
  secretValues: ["SEGREDO-123456"],
  missing: [],
  ...over,
});

describe("simulador: leitura real (REVISAO-113 #1)", () => {
  it("só admin/owner mantém realReadOnlyTools; supervisor vira tudo mock", () => {
    const req = { realReadOnlyTools: ["consultar_debitos"] };
    expect(applyRealReadPolicy({ role: "owner" }, req)).toEqual({ request: req, denied: false });
    expect(applyRealReadPolicy({ role: "admin" }, req).request.realReadOnlyTools).toEqual(["consultar_debitos"]);
    for (const role of ["supervisor", "agent", "viewer"] as const) {
      expect(applyRealReadPolicy({ role: role }, req)).toEqual({ request: { realReadOnlyTools: [] }, denied: true });
    }
    expect(applyRealReadPolicy({ role: "supervisor" }, { realReadOnlyTools: [] }).denied).toBe(false);
  });

  it("ferramenta que NÃO é do catálogo salvo (inline/rascunho): mock, sem credencial nem rede", async () => {
    const realFetch = vi.fn();
    const c = ctx(["consultar_debitos"], realFetch);
    const resolver = vi.fn(real());
    const res = await simulatedToolFetch(c, "n1", new Set())("consultar_debitos", "https://x/***", { method: "GET" }, resolver);
    expect(res.status).toBe(200);
    expect(realFetch).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    expect(c.notes.map((n) => n.label).join(" ")).toMatch(/recusada/);
  });

  it("catálogo salvo + credencial da conta ausente (missing): não faz a chamada real", async () => {
    const realFetch = vi.fn();
    const c = ctx(["consultar_debitos"], realFetch);
    const res = await simulatedToolFetch(c, "n1", new Set(["consultar_debitos"]))(
      "consultar_debitos",
      "https://x/***",
      { method: "GET" },
      real({ missing: ["DDM_TOKEN"], credentialInjected: false }),
    );
    expect(res.status).toBe(200);
    expect(realFetch).not.toHaveBeenCalled();
    expect(c.notes.map((n) => n.label).join(" ")).toMatch(/sem credencial da conta/);
  });

  it("catálogo salvo + credencial da conta: chamada real, resposta sem eco do segredo", async () => {
    const realFetch = vi.fn(async () => new Response("eco SEGREDO-123456 fim", { status: 200 }));
    const c = ctx(["consultar_debitos"], realFetch);
    const res = await simulatedToolFetch(c, "n1", new Set(["consultar_debitos"]))("consultar_debitos", "https://x/***", { method: "GET" }, real());
    expect(realFetch).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("eco *** fim");
  });

  it("savedCatalogToolNames: só nome ligado no catálogo com http idêntico", async () => {
    const http = { url: "https://api.exemplo.com/x", method: "GET" };
    const rows = [
      { name: "consultar_debitos", http: { method: "GET", url: "https://api.exemplo.com/x" }, enabled: true },
      { name: "desligada", http, enabled: false },
      { name: "alterada", http, enabled: true },
    ];
    const db = { from: () => ({ select: () => ({ eq: async () => ({ data: rows }) }) }) } as never;
    const names = await savedCatalogToolNames(db, "a", [
      { name: "consultar_debitos", http },
      { name: "desligada", http },
      { name: "alterada", http: { ...http, url: "https://evil.com/x" } },
      { name: "inline", http },
    ]);
    expect([...names]).toEqual(["consultar_debitos"]);
  });
});
