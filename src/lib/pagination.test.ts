import { describe, expect, it } from "vitest";
import { pageRange, parsePageParams, splitPage } from "./pagination";

const sp = (q: string) => new URLSearchParams(q);

describe("pagination", () => {
  it("sem limit mantém o comportamento antigo quando defaultLimit é null", () => {
    expect(parsePageParams(sp(""), { defaultLimit: null, maxLimit: 200 })).toEqual({ limit: null, offset: 0 });
  });

  it("usa o limite padrão e limita ao máximo", () => {
    expect(parsePageParams(sp(""), { defaultLimit: 50, maxLimit: 100 })).toEqual({ limit: 50, offset: 0 });
    expect(parsePageParams(sp("limit=500&offset=100"), { defaultLimit: 50, maxLimit: 100 })).toEqual({ limit: 100, offset: 100 });
    expect(parsePageParams(sp("limit=0"), { defaultLimit: 50, maxLimit: 100 }).limit).toBe(1);
  });

  it("ignora valores inválidos", () => {
    expect(parsePageParams(sp("limit=abc&offset=-5"), { defaultLimit: 50, maxLimit: 100 })).toEqual({ limit: 50, offset: 0 });
  });

  it("pede uma linha a mais e separa has_more", () => {
    expect(pageRange({ limit: 50, offset: 100 })).toEqual([100, 150]);
    const rows = Array.from({ length: 51 }, (_, i) => i);
    expect(splitPage(rows, 50)).toEqual({ rows: rows.slice(0, 50), hasMore: true });
    expect(splitPage(rows.slice(0, 50), 50).hasMore).toBe(false);
  });
});
