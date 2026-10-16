import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unstable_serialize } from "swr";
import { clearSwrCache, getSwrCacheStore, swrCacheSize } from "./cache";
import { buildSwrKey, isSafeKeyParam, matchesSwrName, type SwrScope } from "./keys";
import { scopeId, shouldClearOnScopeChange } from "./scope";

const contaA: SwrScope = { accountId: "acc-A", userId: "user-1" };
const contaB: SwrScope = { accountId: "acc-B", userId: "user-1" };
const outroUsuarioContaA: SwrScope = { accountId: "acc-A", userId: "user-2" };

/** Lê/escreve no cache exatamente como o SWR: pela chave serializada. */
function put(store: Map<string, unknown>, scope: SwrScope, name: string, data: unknown) {
  const key = buildSwrKey(scope, name, ["x"]);
  store.set(unstable_serialize(key), { data });
}
function get(store: Map<string, unknown>, scope: SwrScope, name: string) {
  const key = buildSwrKey(scope, name, ["x"]);
  return store.get(unstable_serialize(key)) as { data: unknown } | undefined;
}

describe("chaves escopadas", () => {
  it("incluem conta e usuário", () => {
    expect(buildSwrKey(contaA, "dashboard.metrics", [30])).toEqual(["ddm", "acc-A", "user-1", "dashboard.metrics", 30]);
  });

  it("não existem sem conta ou sem usuário (SWR não busca)", () => {
    expect(buildSwrKey(null, "x")).toBeNull();
    expect(buildSwrKey({ accountId: "", userId: "u" }, "x")).toBeNull();
    expect(buildSwrKey({ accountId: "a", userId: "" }, "x")).toBeNull();
  });

  it("são diferentes por conta e por usuário", () => {
    const a = unstable_serialize(buildSwrKey(contaA, "n"));
    expect(unstable_serialize(buildSwrKey(contaB, "n"))).not.toBe(a);
    expect(unstable_serialize(buildSwrKey(outroUsuarioContaA, "n"))).not.toBe(a);
  });

  it("recusam dado pessoal como parâmetro (e-mail, telefone, texto longo)", () => {
    expect(() => buildSwrKey(contaA, "contatos", ["maria@empresa.com.br"])).toThrow();
    expect(() => buildSwrKey(contaA, "contatos", ["+55 (11) 91234-5678"])).toThrow();
    expect(() => buildSwrKey(contaA, "contatos", ["5511912345678"])).toThrow();
    expect(() => buildSwrKey(contaA, "contatos", ["x".repeat(500)])).toThrow();
  });

  it("aceitam ids, números, booleanos, null e enums", () => {
    expect(isSafeKeyParam("3f2b8c1e-7a4d-4e0b-9c55-1d2e3f4a5b6c")).toBe(true);
    expect(isSafeKeyParam("/api/monitoramento/sla?days=1")).toBe(true);
    expect(isSafeKeyParam(25)).toBe(true);
    expect(isSafeKeyParam(false)).toBe(true);
    expect(isSafeKeyParam(null)).toBe(true);
  });

  it("casa por nome para invalidar após escrita", () => {
    expect(matchesSwrName(buildSwrKey(contaA, "contacts.list", [0]), "contacts.list")).toBe(true);
    expect(matchesSwrName(buildSwrKey(contaA, "contacts.tags"), "contacts.list")).toBe(false);
    expect(matchesSwrName("outra-chave", "contacts.list")).toBe(false);
  });
});

describe("cache em memória", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    clearSwrCache();
  });
  afterEach(() => {
    clearSwrCache();
    vi.unstubAllGlobals();
  });

  it("isola dados entre contas e entre usuários", () => {
    const store = getSwrCacheStore();
    put(store, contaA, "contacts.list", ["contato da conta A"]);

    expect(get(store, contaA, "contacts.list")?.data).toEqual(["contato da conta A"]);
    // Mesmo usuário em outra conta, ou outro usuário na mesma conta: nunca vê o dado da conta A.
    expect(get(store, contaB, "contacts.list")).toBeUndefined();
    expect(get(store, outroUsuarioContaA, "contacts.list")).toBeUndefined();
  });

  it("é um singleton por aba e clearSwrCache esvazia tudo (logout, troca de conta, sessão expirada)", () => {
    const store = getSwrCacheStore();
    expect(getSwrCacheStore()).toBe(store);
    put(store, contaA, "a", 1);
    put(store, contaB, "b", 2);
    expect(swrCacheSize()).toBe(2);

    clearSwrCache();

    expect(swrCacheSize()).toBe(0);
    expect(get(store, contaA, "a")).toBeUndefined();
    expect(get(store, contaB, "b")).toBeUndefined();
  });

  it("nunca toca localStorage, sessionStorage nem IndexedDB", () => {
    const boom = new Proxy({}, { get: () => { throw new Error("storage do navegador usado"); } });
    vi.stubGlobal("localStorage", boom);
    vi.stubGlobal("sessionStorage", boom);
    vi.stubGlobal("indexedDB", boom);
    const store = getSwrCacheStore();
    put(store, contaA, "a", { cpf: "000" });
    expect(get(store, contaA, "a")).toBeDefined();
    clearSwrCache();
    expect(swrCacheSize()).toBe(0);
  });

  it("o código de src/lib/swr não referencia armazenamento persistente", () => {
    const dir = __dirname;
    const files = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const code = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join("\n");
      expect(code, f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    }
  });
});

describe("cache no servidor (SSR)", () => {
  it("devolve um Map novo a cada chamada: nada compartilhado entre requisições", () => {
    vi.stubGlobal("window", undefined);
    try {
      const a = getSwrCacheStore();
      const b = getSwrCacheStore();
      expect(a).not.toBe(b);
      a.set("k", 1);
      expect(b.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("escopo (troca de conta/usuário)", () => {
  it("identifica o escopo só com conta e usuário", () => {
    expect(scopeId(contaA)).toBe("user-1:acc-A");
    expect(scopeId(null)).toBeNull();
    expect(scopeId({ accountId: "a", userId: "" })).toBeNull();
  });

  it("limpa quando o escopo muda ou some, e não limpa na primeira resolução", () => {
    expect(shouldClearOnScopeChange(null, "user-1:acc-A")).toBe(false);
    expect(shouldClearOnScopeChange("user-1:acc-A", "user-1:acc-A")).toBe(false);
    expect(shouldClearOnScopeChange("user-1:acc-A", "user-1:acc-B")).toBe(true); // troca de conta
    expect(shouldClearOnScopeChange("user-1:acc-A", "user-2:acc-A")).toBe(true); // troca de usuário
    expect(shouldClearOnScopeChange("user-1:acc-A", null)).toBe(true); // logout / sessão expirada
  });
});

describe("fetcher: 401", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/api-fetch");
    vi.doUnmock("@/lib/supabase/client");
    vi.unstubAllGlobals();
  });

  async function load(response: Response, mfa: boolean, supabase: unknown = {}) {
    vi.resetModules();
    vi.doMock("@/lib/api-fetch", () => ({
      apiFetch: vi.fn(async () => response),
      isMfaRequiredResponse: vi.fn(async () => mfa),
    }));
    vi.doMock("@/lib/supabase/client", () => ({ createClient: () => supabase }));
    const cache = await import("./cache");
    const fetcher = await import("./fetcher");
    return { ...cache, ...fetcher };
  }

  it("401 esvazia o cache, aciona o tratamento de sessão e lança erro", async () => {
    vi.stubGlobal("window", {});
    const m = await load(new Response("{}", { status: 401 }), false);
    const store = m.getSwrCacheStore();
    store.set("dado", { data: "pessoal" });
    const handler = vi.fn(async () => {
      m.clearSwrCache();
    });
    m.setSwrUnauthorizedHandler(handler);

    await expect(m.swrJsonFetcher("/api/x")).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.size).toBe(0);
  });

  it("sem sessão no navegador encerra e vai ao login; com sessão viva só limpa o cache", async () => {
    const replace = vi.fn();
    vi.stubGlobal("window", { location: { replace } });
    const signOut = vi.fn(async () => ({}));
    let session: unknown = null;
    const supabase = { auth: { getSession: async () => ({ data: { session } }), signOut } };
    const m = await load(new Response("{}", { status: 401 }), false, supabase);

    m.getSwrCacheStore().set("dado", 1);
    await expect(m.swrJsonFetcher("/api/x")).rejects.toMatchObject({ status: 401 });
    expect(replace).toHaveBeenCalledWith("/login");
    expect(signOut).toHaveBeenCalled();
    expect(m.swrCacheSize()).toBe(0);

    replace.mockClear();
    session = { user: { id: "u" } };
    m.getSwrCacheStore().set("dado", 1);
    await expect(m.swrJsonFetcher("/api/x")).rejects.toMatchObject({ status: 401 });
    expect(replace).not.toHaveBeenCalled(); // 401 isolado com sessão viva não derruba o usuário
    expect(m.swrCacheSize()).toBe(0); // mas nada fica na memória
  });

  it("401 de 2FA obrigatório não é tratado como sessão expirada", async () => {
    vi.stubGlobal("window", {});
    const m = await load(new Response("{}", { status: 401 }), true);
    const handler = vi.fn(async () => undefined);
    m.setSwrUnauthorizedHandler(handler);
    await expect(m.swrJsonFetcher("/api/x")).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
  });

  it("2xx devolve o JSON; outros erros viram SwrHttpError com o status", async () => {
    vi.stubGlobal("window", {});
    const ok = await load(new Response(JSON.stringify({ a: 1 }), { status: 200 }), false);
    await expect(ok.swrJsonFetcher("/api/x")).resolves.toEqual({ a: 1 });
    const bad = await load(new Response("{}", { status: 500 }), false);
    await expect(bad.swrJsonFetcher("/api/x")).rejects.toMatchObject({ status: 500 });
  });
});
