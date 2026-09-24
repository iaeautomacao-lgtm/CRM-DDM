import { describe, expect, it } from "vitest";
import {
  looksLikeImportHeader,
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

  it("detects headers and does not import the header row", () => {
    const headers = ["CONTATO", "CPF", "VAR1", "VAR2", "VAR3"];
    expect(looksLikeImportHeader(headers)).toBe(true);
    const result = resolveImportRows(headers, [["5511999999999", "123", "a", "b", "c"]], suggestImportColumnMap(headers));

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ phone: "5511999999999", cpf: "123" });
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
});