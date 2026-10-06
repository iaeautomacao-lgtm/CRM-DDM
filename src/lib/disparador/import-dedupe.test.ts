import { describe, expect, it } from "vitest";
import {
  dedupeAltPhoneAssignments,
  dedupeByKey,
  dedupeImportVariables,
  importPhoneKey,
  writeInBatches,
} from "./import-dedupe";
import { formatBrazilianPhone } from "./phone-key";

describe("dedupeByKey", () => {
  it("última ocorrência vence, na posição da primeira", () => {
    const rows = [
      { k: "a", v: 1 },
      { k: "b", v: 2 },
      { k: "a", v: 3 },
    ];
    expect(dedupeByKey(rows, (r) => r.k)).toEqual([
      { k: "a", v: 3 },
      { k: "b", v: 2 },
    ]);
  });

  it("lista vazia", () => {
    expect(dedupeByKey([], () => "x")).toEqual([]);
  });
});

describe("dedupeImportVariables", () => {
  it("mesmo contato duas vezes no CSV vira uma linha por (contato, VAR)", () => {
    const rows = [
      { contact_id: "c1", var_index: 0, value: "antigo" },
      { contact_id: "c1", var_index: 1, value: "R$ 10" },
      { contact_id: "c2", var_index: 0, value: "Ana" },
      { contact_id: "c1", var_index: 0, value: "novo" },
    ];
    const out = dedupeImportVariables(rows);
    expect(out).toHaveLength(3);
    expect(out.find((r) => r.contact_id === "c1" && r.var_index === 0)?.value).toBe("novo");
  });

  it("nenhum par (contact_id, var_index) repetido — o upsert em lote não colide", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      contact_id: `c${i % 50}`,
      var_index: i % 3,
      value: String(i),
    }));
    const out = dedupeImportVariables(rows);
    const keys = out.map((r) => `${r.contact_id}:${r.var_index}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("dedupeAltPhoneAssignments", () => {
  it("chave (contact_id, ordem)", () => {
    const out = dedupeAltPhoneAssignments([
      { contact_id: "c1", ordem: 2, phone: "+5511911111111" },
      { contact_id: "c1", ordem: 2, phone: "+5511922222222" },
      { contact_id: "c1", ordem: 3, phone: "+5511933333333" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].phone).toBe("+5511922222222");
  });
});

describe("importPhoneKey", () => {
  it("o mesmo celular com e sem o 9º dígito é duplicado no import", () => {
    const comNove = formatBrazilianPhone("(11) 99999-8888");
    const semNove = formatBrazilianPhone("11 9999-8888");
    expect(importPhoneKey(comNove)).toBe(importPhoneKey(semNove));
    expect(importPhoneKey("+5511999998888")).toBe(importPhoneKey("5511999998888"));
  });

  it("números diferentes continuam diferentes", () => {
    expect(importPhoneKey("+5511999998888")).not.toBe(importPhoneKey("+5521999998888"));
    // fixo não colide com o celular de mesmos dígitos
    expect(importPhoneKey("+551134567890")).not.toBe(importPhoneKey("+5511934567890"));
  });
});

describe("writeInBatches", () => {
  it("lote com erro não interrompe os seguintes e é contabilizado", async () => {
    const written: number[][] = [];
    const rows = Array.from({ length: 250 }, (_, i) => i);
    const summary = await writeInBatches(rows, 100, async (chunk) => {
      written.push(chunk);
      return chunk[0] === 100 ? { message: "ON CONFLICT DO UPDATE command cannot affect row a second time" } : null;
    });
    expect(written).toHaveLength(3);
    expect(summary).toEqual({
      totalBatches: 3,
      failedBatches: 1,
      failedRows: 100,
      firstError: "ON CONFLICT DO UPDATE command cannot affect row a second time",
    });
  });

  it("exceção no lote também é contabilizada", async () => {
    const summary = await writeInBatches([1, 2, 3], 2, async (chunk) => {
      if (chunk[0] === 1) throw new Error("rede");
      return null;
    });
    expect(summary.failedBatches).toBe(1);
    expect(summary.failedRows).toBe(2);
    expect(summary.firstError).toBe("rede");
    expect(summary.totalBatches).toBe(2);
  });

  it("sem linhas, sem lotes", async () => {
    const summary = await writeInBatches([], 100, async () => null);
    expect(summary).toEqual({ totalBatches: 0, failedBatches: 0, failedRows: 0, firstError: null });
  });
});
