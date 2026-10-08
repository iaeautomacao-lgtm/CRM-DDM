import { describe, expect, it } from "vitest";
import { codigoInUseBy, codigoTabulacaoBloqueado, parseCodigoTabulacao } from "./codigo";

describe("codigoTabulacaoBloqueado", () => {
  it.each([142, 220, 178, 156, 227, 376, 208])("protege código padrão %i apenas quando a própria tag está no mapa", (codigo) => {
    const tag = { id: "padrao", codigo_tabulacao: codigo };
    expect(codigoTabulacaoBloqueado(tag, new Set(["padrao"]))).toBe(true);
    expect(codigoTabulacaoBloqueado(tag, new Set(["outra"]))).toBe(false);
  });
  it("permite criar e editar códigos personalizados/sem código mesmo mapeados", () => {
    const mapped = new Set(["custom"]);
    expect(codigoTabulacaoBloqueado(null, mapped)).toBe(false);
    expect(codigoTabulacaoBloqueado({ id: "custom", codigo_tabulacao: 900 }, mapped)).toBe(false);
    expect(codigoTabulacaoBloqueado({ id: "custom", codigo_tabulacao: null }, mapped)).toBe(false);
  });
});

describe("parseCodigoTabulacao", () => {
  it("vazio = sem código", () => {
    expect(parseCodigoTabulacao("  ")).toEqual({ ok: true, value: null });
  });
  it("inteiro válido (inclui 0)", () => {
    expect(parseCodigoTabulacao("142")).toEqual({ ok: true, value: 142 });
    expect(parseCodigoTabulacao("0")).toEqual({ ok: true, value: 0 });
  });
  it("rejeita não inteiro, negativo e grande demais", () => {
    expect(parseCodigoTabulacao("14.2").ok).toBe(false);
    expect(parseCodigoTabulacao("-1").ok).toBe(false);
    expect(parseCodigoTabulacao("abc").ok).toBe(false);
    expect(parseCodigoTabulacao("100000").ok).toBe(false);
  });
});

describe("codigoInUseBy", () => {
  const tags = [
    { id: "a", name: "Acordo", codigo_tabulacao: 142 },
    { id: "b", name: "Sem código", codigo_tabulacao: null },
  ];
  it("acusa duplicata em outra tag", () => {
    expect(codigoInUseBy(tags, 142)).toBe("Acordo");
  });
  it("a própria tag em edição não conta", () => {
    expect(codigoInUseBy(tags, 142, "a")).toBeNull();
  });
  it("sem código nunca conflita", () => {
    expect(codigoInUseBy(tags, null)).toBeNull();
  });
});
