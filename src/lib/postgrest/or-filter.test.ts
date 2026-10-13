import { describe, expect, it } from "vitest";

import { escapeLike, orIlikeContains, pgrstQuote } from "./or-filter";

describe("pgrstQuote", () => {
  it("coloca entre aspas e escapa aspas e barra invertida", () => {
    expect(pgrstQuote("ana")).toBe('"ana"');
    expect(pgrstQuote('a"b')).toBe('"a\\"b"');
    expect(pgrstQuote("a\\b")).toBe('"a\\\\b"');
  });
});

describe("escapeLike", () => {
  it("%, _ e \ viram literais", () => {
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    expect(escapeLike("João")).toBe("João");
  });
});

describe("orIlikeContains", () => {
  it("monta um filtro por coluna com o termo entre aspas", () => {
    expect(orIlikeContains(["name", "phone"], "ana")).toBe('name.ilike."%ana%",phone.ilike."%ana%"');
  });

  it("termo vazio não gera filtro", () => {
    expect(orIlikeContains(["name"], "   ")).toBe("");
  });

  it("uma tentativa de fechar o filtro e acrescentar outro fica DENTRO do valor", () => {
    const f = orIlikeContains(["name", "phone"], 'x",id.gt.0,name.ilike."y');
    // o valor inteiro está entre aspas e as aspas internas estão escapadas: só há 2 filtros (name e phone)
    expect(f).toBe('name.ilike."%x\\",id.gt.0,name.ilike.\\"y%",phone.ilike."%x\\",id.gt.0,name.ilike.\\"y%"');
    // tirando os valores entre aspas (com as aspas escapadas lá dentro), sobram só os 2 filtros que nós montamos
    const outside = f.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(outside).toBe('name.ilike."",phone.ilike.""');
  });

  it("parênteses e vírgulas do termo não quebram a gramática", () => {
    const f = orIlikeContains(["name"], "a,b(c)");
    expect(f).toBe('name.ilike."%a,b(c)%"');
  });
});
