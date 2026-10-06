import { describe, expect, it } from "vitest";
import { detectImportDelimiter, parseImportCsv, summarizeImport, tableFromMatrix } from "./import-parse";
import { phoneKey } from "./phone-key";

describe("parseImportCsv", () => {
  it("detecta separador, cabeçalho e aspas", () => {
    const t = parseImportCsv('﻿telefone;nome;VAR1\n11999998888;"Silva; Maria";R$ 10\n\n11988887777;João;R$ 20\n');
    expect(t.hasHeader).toBe(true);
    expect(t.headers).toEqual(["telefone", "nome", "var1"]);
    expect(t.rows).toEqual([
      ["11999998888", "Silva; Maria", "R$ 10"],
      ["11988887777", "João", "R$ 20"],
    ]);
  });

  it("linha sep= e vírgula", () => {
    expect(detectImportDelimiter("sep=,\na,b").delimiter).toBe(",");
    expect(detectImportDelimiter("telefone,nome\n1,2").delimiter).toBe(",");
    expect(detectImportDelimiter("a;b,c;d").delimiter).toBe(";");
  });

  it("sem cabeçalho: colunas numeradas", () => {
    const t = tableFromMatrix([["11999998888", "Maria"]]);
    expect(t.hasHeader).toBe(false);
    expect(t.headers).toEqual(["coluna_1", "coluna_2"]);
    expect(t.rows).toHaveLength(1);
  });
});

describe("summarizeImport", () => {
  const table = tableFromMatrix([
    ["telefone", "nome", "cpf", "var1"],
    ["11999998888", "Maria", "123.456.789-01", "100"],
    ["+55 11 99999-8888", "Maria dup", "", "100"], // mesmo número (phoneKey)
    ["1199998888", "Maria sem 9", "", ""], // mesmo celular sem o 9º dígito
    ["21988887777", "João", "12345678901", "200"], // mesmo CPF da 1ª linha
    ["", "Sem telefone", "", ""],
    ["12345", "Curto", "", ""],
    ["31977776666", "Ana", "", "300"],
    ["41966665555", "Bloqueado", "", ""],
  ]);
  const map = { phone: "telefone", name: "nome", cpf: "cpf", var1: "var1" };

  it("conta válidos, duplicados (telefone/CPF) e inválidos", () => {
    const s = summarizeImport(table, map);
    expect(s.total).toBe(8);
    expect(s.invalidos).toBe(2);
    expect(s.duplicados).toBe(3);
    expect(s.blacklist).toBe(0);
    expect(s.validos).toBe(3);
    expect(s.rows.map((r) => r.name)).toEqual(["Maria", "Ana", "Bloqueado"]);
    expect(s.rows[0].variables).toEqual(["100", "", ""]);
  });

  it("blacklist conferida no servidor sai dos válidos", () => {
    const s = summarizeImport(table, map, new Set([phoneKey("41966665555")]));
    expect(s.blacklist).toBe(1);
    expect(s.validos).toBe(2);
  });

  it("sem coluna de telefone mapeada, tudo é inválido", () => {
    const s = summarizeImport(table, { name: "nome" });
    expect(s.invalidos).toBe(8);
    expect(s.validos).toBe(0);
  });

  it("50 mil linhas em tempo linear", () => {
    const rows: string[][] = [["telefone", "var1"]];
    for (let i = 0; i < 50_000; i++) rows.push([`119${String(10_000_000 + i)}`, String(i)]);
    const big = tableFromMatrix(rows);
    const t0 = Date.now();
    const s = summarizeImport(big, { phone: "telefone", var1: "var1" });
    expect(s.validos).toBe(50_000);
    // Folga para a suíte inteira em paralelo; O(n²) com 50 mil linhas leva minutos.
    expect(Date.now() - t0).toBeLessThan(15_000);
  });
});
