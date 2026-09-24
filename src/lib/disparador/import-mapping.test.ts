import { describe, expect, it } from "vitest";
import {
  looksLikeImportHeader,
  NO_MAPPING_LABEL,
  NO_MAPPING_VALUE,
  resolveImportRows,
  suggestImportColumnMap,
} from "./import-mapping";

describe("Disparador import column mapping", () => {
  it("resolves variables in the expected order", () => {
    const headers = ["CONTATO", "VAR1", "VAR2", "VAR3"];
    const result = resolveImportRows(headers, [["5511999999999", "a", "b", "c"]], suggestImportColumnMap(headers));

    expect(result.rows[0]).toMatchObject({ phone: "5511999999999", variables: ["a", "b", "c"] });
  });

  it("resolves shuffled variables by their selected columns", () => {
    const headers = ["CONTATO", "VAR3", "VAR2", "VAR1"];
    const result = resolveImportRows(headers, [["5511999999999", "c", "b", "a"]], {
      phone: "CONTATO",
      var1: "VAR1",
      var2: "VAR2",
      var3: "VAR3",
    });

    expect(result.rows[0].variables).toEqual(["a", "b", "c"]);
  });

  it("maps the production CSV example to contact name and template placeholders", () => {
    const headers = ["CONTATO", "VAR3", "VAR2", "VAR1"];
    const map = suggestImportColumnMap(headers);
    const result = resolveImportRows(
      headers,
      [["5511940356557", "cruzeirodosul.meuacordofacil.com.br", "UNICID", "CRISTIANE"]],
      map
    );

    expect(map).toMatchObject({ phone: "CONTATO", name: "VAR1", var1: "VAR1", var2: "VAR2", var3: "VAR3" });
    expect(result.rows[0]).toMatchObject({
      phone: "5511940356557",
      name: "CRISTIANE",
      variables: ["CRISTIANE", "UNICID", "cruzeirodosul.meuacordofacil.com.br"],
    });
  });

  it("detects headers and does not import the header row", () => {
    const headers = ["CONTATO", "CPF", "VAR1", "VAR2", "VAR3"];
    expect(looksLikeImportHeader(headers)).toBe(true);
    const result = resolveImportRows(headers, [["5511999999999", "12345678901", "a", "b", "c"]], suggestImportColumnMap(headers));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ phone: "5511999999999", cpf: "12345678901" });
  });

  it("suggests TELEFONE1 as the primary number without changing alternate-phone behavior", () => {
    const headers = ["TELEFONE1", "TELEFONE2", "VAR1"];

    expect(suggestImportColumnMap(headers).phone).toBe("TELEFONE1");
  });

  it("supports headerless rows and suggests column A as contact", () => {
    const headers = ["coluna_1", "coluna_2", "coluna_3", "coluna_4"];
    const map = suggestImportColumnMap(headers);
    const result = resolveImportRows(headers, [["5511999999999", "c", "b", "a"]], {
      ...map,
      var1: "coluna_4",
      var2: "coluna_3",
      var3: "coluna_2",
    });

    expect(map.phone).toBe("coluna_1");
    expect(result.rows[0].variables).toEqual(["a", "b", "c"]);
  });

  it("fails safely when no contact column is mapped", () => {
    const result = resolveImportRows(["VAR1", "VAR2"], [["a", "b"]], {});

    expect(result.rows).toHaveLength(0);
    expect(result.invalidRows).toBe(1);
  });

  it("keeps the internal empty mapping value without resolving a fake column", () => {
    const result = resolveImportRows(
      ["CONTATO", "CPF", "VAR1"],
      [["5511999999999", "12345678901", "a"]],
      { phone: "CONTATO", cpf: NO_MAPPING_VALUE, var1: "VAR1" }
    );

    expect(NO_MAPPING_LABEL).toBe("Nenhum");
    expect(result.rows[0].cpf).toBeUndefined();
    expect(result.rows[0].variables[0]).toBe("a");
  });
});