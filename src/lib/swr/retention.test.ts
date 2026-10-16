import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unstable_serialize } from "swr";
import { clearSwrCache, getSwrCacheStore, swrCacheSize } from "./cache";
import { DEFAULT_MAX_ENTRIES, isRetained, retainedCount, touchRetained } from "./retention";
import { buildSwrKey } from "./keys";
import { clearSessionData } from "@/lib/auth/session-cleanup";

const scope = { accountId: "acc-1", userId: "user-A" };
const NAME = "contacts.list";
const ck = (page: number, token: string) => unstable_serialize(buildSwrKey(scope, NAME, [page, "", token]));

/** O que a tela de contatos declara (src/app/(dashboard)/contacts/page.tsx). */
const contactsRetention = (token: string) => ({ maxEntries: 10, group: token, maxGroups: 2 });

function open(store: Map<string, unknown>, page: number, token: string) {
  const key = ck(page, token);
  store.set(key, { data: { rows: [`contato ${token} p${page}`] } }); // o SWR grava a resposta
  return touchRetained(store, NAME, key, contactsRetention(token));
}

describe("teto de memória do cache (busca de contatos)", () => {
  beforeEach(() => {
    vi.stubGlobal("window", {});
    clearSwrCache();
  });
  afterEach(() => {
    clearSwrCache();
    vi.unstubAllGlobals();
  });

  it("só a busca atual e a anterior ficam: ao trocar o termo, as mais antigas são descartadas", () => {
    const store = getSwrCacheStore();
    open(store, 0, "all"); // lista sem busca
    open(store, 0, "tok-maria"); // busca "maria"
    expect(store.has(ck(0, "all"))).toBe(true);
    expect(store.has(ck(0, "tok-maria"))).toBe(true);

    const evicted = open(store, 0, "tok-joao"); // busca "joao": a lista sem busca (mais antiga) sai
    expect(evicted).toEqual([ck(0, "all")]);
    expect(store.has(ck(0, "all"))).toBe(false);
    expect(store.has(ck(0, "tok-maria"))).toBe(true);
    expect(store.has(ck(0, "tok-joao"))).toBe(true);

    open(store, 0, "tok-ana");
    expect(store.has(ck(0, "tok-maria"))).toBe(false); // nome/telefone da busca antiga não ficam acumulando
    expect(swrCacheSize()).toBe(2);
  });

  it("páginas de uma mesma busca param no teto (as mais antigas saem)", () => {
    const store = getSwrCacheStore();
    for (let p = 0; p < 15; p++) open(store, p, "all");
    expect(swrCacheSize()).toBe(10);
    expect(store.has(ck(0, "all"))).toBe(false);
    expect(store.has(ck(4, "all"))).toBe(false);
    expect(store.has(ck(5, "all"))).toBe(true);
    expect(store.has(ck(14, "all"))).toBe(true);
  });

  it("voltar a uma página renova a recência (LRU)", () => {
    const store = getSwrCacheStore();
    for (let p = 0; p < 10; p++) open(store, p, "all");
    touchRetained(store, NAME, ck(0, "all"), contactsRetention("all")); // usuário volta à página 0
    open(store, 10, "all"); // estoura o teto: sai a página 1, não a 0
    expect(store.has(ck(0, "all"))).toBe(true);
    expect(store.has(ck(1, "all"))).toBe(false);
  });

  it("resposta que chega depois de a chave sair do teto não é considerada retida", () => {
    const store = getSwrCacheStore();
    open(store, 0, "tok-a");
    open(store, 0, "tok-b");
    open(store, 0, "tok-c"); // tok-a saiu
    expect(isRetained(NAME, ck(0, "tok-a"))).toBe(false); // use-scoped-swr apaga a escrita tardia
    expect(isRetained(NAME, ck(0, "tok-c"))).toBe(true);
  });

  it("nomes diferentes têm tetos independentes", () => {
    const store = getSwrCacheStore();
    touchRetained(store, "a", "k1", { maxEntries: 1 });
    touchRetained(store, "b", "k2", { maxEntries: 1 });
    expect(retainedCount()).toBe(2);
    touchRetained(store, "a", "k3", { maxEntries: 1 });
    expect(isRetained("a", "k1")).toBe(false);
    expect(isRetained("b", "k2")).toBe(true);
  });

  it("sem declaração o teto padrão (30) protege qualquer chave futura que varie", () => {
    const store = getSwrCacheStore();
    for (let i = 0; i < DEFAULT_MAX_ENTRIES + 20; i++) {
      store.set(`k${i}`, { data: i });
      touchRetained(store, "qualquer", `k${i}`, { maxEntries: DEFAULT_MAX_ENTRIES });
    }
    expect(swrCacheSize()).toBe(DEFAULT_MAX_ENTRIES);
  });

  it("clearSessionData (logout, troca de conta, sessão expirada) apaga o cache e o controle de retenção", () => {
    const store = getSwrCacheStore();
    open(store, 0, "tok-maria");
    open(store, 1, "tok-maria");
    expect(swrCacheSize()).toBe(2);
    expect(retainedCount()).toBe(2);

    vi.stubGlobal("window", { localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} } });
    clearSessionData();

    expect(swrCacheSize()).toBe(0);
    expect(retainedCount()).toBe(0);
    expect(isRetained(NAME, ck(0, "tok-maria"))).toBe(false);
  });
});

describe("teto em uso real (fonte)", () => {
  it("a tela de contatos declara o teto e o grupo pelo token da busca", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("src/app/(dashboard)/contacts/page.tsx", "utf8");
    expect(page).toMatch(/retain: \{ maxEntries: CONTACTS_CACHE_MAX_ENTRIES, group: searchToken, maxGroups: CONTACTS_CACHE_MAX_SEARCHES \}/);
    expect(page).toMatch(/CONTACTS_CACHE_MAX_SEARCHES = 2/);
  });

  it("todo hook passa pelo teto (padrão de 30 por nome)", async () => {
    const { readFileSync } = await import("node:fs");
    const hook = readFileSync("src/lib/swr/use-scoped-swr.ts", "utf8");
    expect(hook).toMatch(/useRetention\(name, key, retain, loader\)/);
    expect(hook).toMatch(/useRetention\(name, key, retain, load\)/);
  });
});

describe("outras memórias do Inbox também saem com a sessão", () => {
  it("a origem das conversas (cache de 2 min) é esvaziada por clearSessionData", async () => {
    const { originCache } = await import("@/lib/inbox/origin-cache");
    vi.stubGlobal("window", { localStorage: { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} } });
    originCache.set("conv-1", Promise.resolve({ client: "Cliente X" }));
    clearSessionData();
    expect(originCache.size).toBe(0);
    vi.unstubAllGlobals();
  });
});
