import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSessionData } from "./session-cleanup";
import { getSwrCacheStore, swrCacheSize } from "@/lib/swr/cache";
import { cacheThread, getCachedThread } from "@/lib/inbox/thread-pages";
import { draftKey, readDraft, writeDraft } from "@/lib/inbox/drafts";
import type { Message } from "@/types";

const msg = (id: string): Message =>
  ({ id, conversation_id: "conv-1", sender_type: "customer", content_type: "text", content_text: "oi, meu CPF é 000", status: "read", created_at: "2026-10-16T12:00:00Z" }) as Message;

describe("clearSessionData (logout, troca de conta/usuário, sessão expirada)", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("window", {
      localStorage: {
        get length() {
          return store.size;
        },
        key: (i: number) => [...store.keys()][i] ?? null,
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("esvazia cache SWR, cache de mensagens do Inbox e rascunhos de uma vez", () => {
    const scope = { accountId: "acc-1", userId: "user-A" };
    getSwrCacheStore().set("ddm|acc-1|user-A|contacts.list", { data: ["Maria"] });
    cacheThread("conv-1", [msg("m1")]);
    writeDraft(scope, "conv-1", "rascunho com valor do acordo");
    expect(swrCacheSize()).toBe(1);
    expect(getCachedThread("conv-1")).not.toBeNull();
    expect(readDraft(scope, "conv-1")).toBe("rascunho com valor do acordo");

    clearSessionData();

    expect(swrCacheSize()).toBe(0);
    expect(getCachedThread("conv-1")).toBeNull();
    expect(readDraft(scope, "conv-1")).toBeNull();
    expect(store.has(draftKey(scope, "conv-1"))).toBe(false);
  });

  it("mensagens da sessão anterior não aparecem para o próximo usuário", () => {
    cacheThread("conv-1", [msg("m1"), msg("m2")]);
    clearSessionData();
    expect(getCachedThread("conv-1")).toBeNull(); // o próximo usuário que abrir a conversa não vê o snapshot de A
  });
});

describe("ganchos de limpeza", () => {
  it("logout, sessão encerrada, troca de escopo e 401 chamam clearSessionData (e não só o cache SWR)", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (p: string) => readFileSync(p, "utf8");
    const auth = read("src/hooks/use-auth.tsx");
    // signOut (2x), evento sem usuário (1x)
    expect((auth.match(/clearSessionData\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(auth).not.toMatch(/clearSwrCache\(\)/);
    expect(read("src/lib/swr/provider.tsx")).toMatch(/shouldClearOnScopeChange\(previous\.current, current\)\) clearSessionData\(\)/);
    expect(read("src/lib/swr/fetcher.ts")).toMatch(/clearSessionData\(\)/);
  });

  it("o compositor não escreve mais no localStorage com a chave antiga", async () => {
    const { readFileSync } = await import("node:fs");
    const composer = readFileSync("src/components/inbox/message-composer.tsx", "utf8");
    expect(composer).not.toMatch(/wacrm:draft:\$\{/);
    expect(composer).not.toMatch(/localStorage\.(setItem|getItem|removeItem)\(`wacrm:draft/);
  });
});
