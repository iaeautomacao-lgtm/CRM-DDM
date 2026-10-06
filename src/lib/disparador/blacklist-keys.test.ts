import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBlacklistKeySet } from "./blacklist-keys";
import { phoneKey } from "./phone-key";

// Fake mínimo do query builder: devolve fatias de `rows` conforme .range().
function fakeDb(rows: Array<{ telefone: string }>, error: { message: string } | null = null) {
  const ranges: Array<[number, number]> = [];
  const db = {
    from: () => {
      const builder = {
        select: () => builder,
        order: () => builder,
        range: async (from: number, to: number) => {
          ranges.push([from, to]);
          return error ? { data: null, error } : { data: rows.slice(from, to + 1), error: null };
        },
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, ranges };
}

describe("loadBlacklistKeySet", () => {
  it("pagina além de 1000 linhas", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({
      telefone: `+55119${String(10000000 + i)}`,
    }));
    const { db, ranges } = fakeDb(rows);
    const keys = await loadBlacklistKeySet(db);
    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    expect(keys.has(phoneKey(rows[2499].telefone))).toBe(true);
    expect(keys.size).toBe(2500);
  });

  it("erro de leitura lança em vez de seguir sem blacklist", async () => {
    const { db } = fakeDb([], { message: "timeout" });
    await expect(loadBlacklistKeySet(db)).rejects.toThrow(/blacklist/);
  });
});
