import { describe, expect, it } from "vitest";
import { fetchAllKeyset } from "./keyset";

type Row = { id: string; v: number };
const idOf = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

// Fonte ordenada por id; cada página começa DEPOIS do cursor.
function source(rows: Row[], failAtCall?: number) {
  const calls: Array<{ after: string | number | null; limit: number }> = [];
  const fetchPage = async (after: string | number | null, limit: number) => {
    calls.push({ after, limit });
    if (failAtCall && calls.length === failAtCall) return { data: null, error: { message: "boom" } };
    return { data: rows.filter((r) => after === null || r.id > after).slice(0, limit), error: null };
  };
  return { fetchPage, calls };
}

describe("fetchAllKeyset", () => {
  it("lê mais de 1.000 linhas sem pular nem duplicar", async () => {
    const rows = Array.from({ length: 2345 }, (_, i) => ({ id: idOf(i * 2 + 1), v: i }));
    const { fetchPage, calls } = source(rows);
    const out = await fetchAllKeyset("rótulo", fetchPage);
    expect(out).toHaveLength(2345);
    expect(new Set(out.map((r) => r.id)).size).toBe(2345);
    expect(out.map((r) => r.v)).toEqual(rows.map((r) => r.v));
    expect(calls.map((c) => c.after)).toEqual([null, rows[999].id, rows[1999].id]);
  });

  it("linha inserida ANTES do cursor durante a leitura não repete nem desloca (OFFSET deslocaria)", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: idOf(i * 2 + 2), v: i }));
    const { fetchPage } = source(rows);
    let first = true;
    const racing = async (after: string | number | null, limit: number) => {
      const page = await fetchPage(after, limit);
      if (first) {
        first = false;
        rows.push({ id: idOf(1), v: -1 });
        rows.sort((a, b) => (a.id < b.id ? -1 : 1));
      }
      return page;
    };
    const out = await fetchAllKeyset("x", racing);
    expect(new Set(out.map((r) => r.id)).size).toBe(out.length);
    expect(out).toHaveLength(1500);
  });

  it("página exata e tabela vazia", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: idOf(i + 1), v: i }));
    const a = source(full);
    expect(await fetchAllKeyset("x", a.fetchPage)).toHaveLength(1000);
    expect(a.calls).toHaveLength(2);
    const b = source([]);
    expect(await fetchAllKeyset("x", b.fetchPage)).toEqual([]);
    expect(b.calls).toHaveLength(1);
  });

  it("aceita ids numéricos e propaga o erro com o rótulo", async () => {
    const rows = Array.from({ length: 2100 }, (_, i) => ({ id: i + 1, v: i }));
    const num = async (after: string | number | null, limit: number) => ({
      data: rows.filter((r) => after === null || r.id > (after as number)).slice(0, limit),
      error: null,
    });
    expect(await fetchAllKeyset("n", num)).toHaveLength(2100);
    const bad = source(rows as never, 2);
    await expect(fetchAllKeyset("Erro ao carregar X", bad.fetchPage as never)).rejects.toThrow(/Erro ao carregar X: boom/);
  });
});
