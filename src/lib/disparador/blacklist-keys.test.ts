import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBlacklistKeySet } from "./blacklist-keys";
import { phoneKey } from "./phone-key";

// Fake do query builder com semântica de keyset: respeita .gt("id", cursor),
// .order("id") e .limit(n) sobre as linhas (ids crescentes, com buracos).
function fakeDb(rows: Array<{ id: number; telefone: string }>, error: { message: string } | null = null) {
  const calls: Array<{ after: number | null; limit: number }> = [];
  const db = {
    from: () => {
      let after: number | null = null;
      let limit = Infinity;
      const builder = {
        select: () => builder,
        order: () => builder,
        gt: (_col: string, value: number) => ((after = value), builder),
        limit: (n: number) => ((limit = n), builder),
        then: (resolve: (value: unknown) => unknown) => {
          calls.push({ after, limit });
          const result = error
            ? { data: null, error }
            : {
                data: rows
                  .filter((r) => after === null || r.id > after)
                  .sort((a, b) => a.id - b.id)
                  .slice(0, limit),
                error: null,
              };
          return Promise.resolve(result).then(resolve);
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

describe("loadBlacklistKeySet", () => {
  it("pagina por keyset além de 1000 linhas, sem pular nem repetir", async () => {
    // ids com buracos (linhas apagadas) e telefones únicos.
    const rows = Array.from({ length: 2500 }, (_, i) => ({
      id: (i + 1) * 3,
      telefone: `+55119${String(10000000 + i)}`,
    }));
    const { db, calls } = fakeDb(rows);
    const keys = await loadBlacklistKeySet(db);
    expect(calls).toEqual([
      { after: null, limit: 1000 },
      { after: 3000, limit: 1000 },
      { after: 6000, limit: 1000 },
    ]);
    expect(keys.has(phoneKey(rows[0].telefone))).toBe(true);
    expect(keys.has(phoneKey(rows[999].telefone))).toBe(true); // fronteira da 1ª página
    expect(keys.has(phoneKey(rows[1000].telefone))).toBe(true); // 1ª da 2ª página
    expect(keys.has(phoneKey(rows[2499].telefone))).toBe(true);
    expect(keys.size).toBe(2500);
  });

  it("página cheia exata (1000) ainda consulta a seguinte e termina vazia", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, telefone: `+55119${String(20000000 + i)}` }));
    const { db, calls } = fakeDb(rows);
    expect((await loadBlacklistKeySet(db)).size).toBe(1000);
    expect(calls).toHaveLength(2);
  });

  it("erro de leitura lança em vez de seguir sem blacklist", async () => {
    const { db } = fakeDb([], { message: "timeout" });
    await expect(loadBlacklistKeySet(db)).rejects.toThrow(/blacklist/);
  });
});

describe("loadBlacklistKeysForPhones", () => {
  const rpcDb = (blocked: string[], rpcError: { message: string } | null = null) => {
    const calls: string[][] = [];
    const db = {
      rpc: async (_fn: string, args: { p_keys: string[] }) => {
        calls.push(args.p_keys);
        return rpcError
          ? { data: null, error: rpcError }
          : { data: args.p_keys.filter((k) => blocked.includes(k)).map((key) => ({ key })), error: null };
      },
    };
    return { db: db as unknown as SupabaseClient, calls };
  };

  it("consulta só as chaves do bloco, em fatias, sem carregar a lista inteira", async () => {
    const { loadBlacklistKeysForPhones } = await import("./blacklist-keys");
    const keys = Array.from({ length: 4500 }, (_, i) => `k${i}`);
    const { db, calls } = rpcDb(["k3", "k4400"]);
    const out = await loadBlacklistKeysForPhones(db, keys);
    expect([...out].sort()).toEqual(["k3", "k4400"]);
    expect(calls.map((c) => c.length)).toEqual([2000, 2000, 500]);
  });

  it("sem chaves não consulta nada", async () => {
    const { loadBlacklistKeysForPhones } = await import("./blacklist-keys");
    const { db, calls } = rpcDb([]);
    expect((await loadBlacklistKeysForPhones(db, [])).size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("RPC ausente: cai na lista inteira e filtra pelas chaves do bloco", async () => {
    const { loadBlacklistKeysForPhones } = await import("./blacklist-keys");
    const inner = fakeDb([{ id: 1, telefone: "11999998888" }, { id: 2, telefone: "21988887777" }]).db as unknown as Record<string, unknown>;
    const db = { ...inner, rpc: async () => ({ data: null, error: { message: "function does not exist" } }) } as unknown as SupabaseClient;
    const out = await loadBlacklistKeysForPhones(db, [phoneKey("11999998888"), phoneKey("31977776666")]);
    expect([...out]).toEqual([phoneKey("11999998888")]);
  });
});
