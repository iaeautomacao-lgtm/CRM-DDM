import { describe, expect, it } from "vitest";
import {
  chunkImportRows,
  contactLookupDigits,
  EMPTY_IMPORT_RESULTS,
  mergeImportResults,
  sliceInto,
} from "./import-chunks";
import { writeInBatches } from "./import-dedupe";

describe("chunkImportRows", () => {
  it("divide em blocos de no máximo maxRows, sem perder nem repetir linhas", () => {
    const rows = Array.from({ length: 12_001 }, (_, i) => ({ n: i }));
    const chunks = chunkImportRows(rows, 5000);
    expect(chunks.map((c) => c.length)).toEqual([5000, 5000, 2001]);
    expect(chunks.flat()).toEqual(rows);
  });

  it("quebra por bytes quando as linhas são largas", () => {
    const wide = { v: "x".repeat(1000) };
    const chunks = chunkImportRows([wide, wide, wide, wide, wide], 5000, 2500);
    expect(chunks.every((c) => c.length <= 2)).toBe(true);
    expect(chunks.flat()).toHaveLength(5);
  });

  it("uma linha maior que o teto vai sozinha e não gera bloco vazio", () => {
    const huge = { v: "x".repeat(5000) };
    const chunks = chunkImportRows([huge, { v: "a" }], 5000, 100);
    expect(chunks).toEqual([[huge], [{ v: "a" }]]);
  });

  it("lista vazia → nenhum bloco", () => {
    expect(chunkImportRows([])).toEqual([]);
  });
});

describe("mergeImportResults", () => {
  it("soma os contadores e junta os erros (com limite)", () => {
    let total = { ...EMPTY_IMPORT_RESULTS };
    total = mergeImportResults(total, { importados: 10, duplicados: 2, erros: ["a"] });
    total = mergeImportResults(total, { importados: 5, invalidos: 1, variaveis_falhas: 3, erros: ["b"] });
    expect(total).toEqual({
      importados: 15,
      duplicados: 2,
      invalidos: 1,
      blacklisted: 0,
      variaveis_falhas: 3,
      erros: ["a", "b"],
    });
    expect(mergeImportResults(total, { erros: ["c", "d"] }, 3).erros).toEqual(["a", "b", "c"]);
  });

  it("resultado ausente não altera o acumulado", () => {
    expect(mergeImportResults(EMPTY_IMPORT_RESULTS, undefined)).toEqual(EMPTY_IMPORT_RESULTS);
  });
});

describe("contactLookupDigits", () => {
  it("cobre com/sem 55 e com/sem o 9º dígito (só dígitos)", () => {
    const digits = contactLookupDigits("+5511999998888");
    expect(digits).toEqual(
      expect.arrayContaining(["5511999998888", "11999998888", "551199998888", "1199998888"]),
    );
    expect(digits.every((d) => /^\d+$/.test(d))).toBe(true);
  });

  it("número fora do padrão BR: só os próprios dígitos", () => {
    expect(contactLookupDigits("+44 20 7946 0958")).toEqual(["442079460958"]);
  });
});

describe("sliceInto", () => {
  it("fatias de tamanho fixo", () => {
    expect(sliceInto([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(sliceInto([], 3)).toEqual([]);
  });
});

describe("writeInBatches com concorrência", () => {
  it("grava todos os lotes respeitando o limite de paralelismo", async () => {
    let running = 0;
    let peak = 0;
    const seen: number[] = [];
    const summary = await writeInBatches(
      Array.from({ length: 10 }, (_, i) => i),
      2,
      async (chunk) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        seen.push(...chunk);
        running--;
        return null;
      },
      3,
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(summary).toMatchObject({ totalBatches: 5, failedBatches: 0, failedRows: 0 });
  });

  it("lote com erro não impede os seguintes", async () => {
    const summary = await writeInBatches([1, 2, 3, 4, 5, 6], 2, async (chunk) => (chunk[0] === 3 ? { message: "boom" } : null), 2);
    expect(summary).toMatchObject({ totalBatches: 3, failedBatches: 1, failedRows: 2, firstError: "boom" });
  });
});
