import { describe, expect, it } from "vitest";
import { resolveUtmLink, utmCpfKey, utmPhoneKey } from "./utm-links";

describe("utmPhoneKey / utmCpfKey", () => {
  it("telefone segue a regra do import (DDI 55)", () => {
    expect(utmPhoneKey("(11) 99999-8888")).toBe("5511999998888");
    expect(utmPhoneKey("+55 11 99999-8888")).toBe("5511999998888");
    expect(utmPhoneKey("")).toBe("");
  });
  it("CPF só com 11 dígitos", () => {
    expect(utmCpfKey("123.456.789-01")).toBe("12345678901");
    expect(utmCpfKey("1234")).toBeNull();
    expect(utmCpfKey(undefined)).toBeNull();
  });
});

describe("resolveUtmLink", () => {
  const maps = {
    byCpf: new Map([["12345678901", "https://l/cpf"]]),
    byPhone: new Map([
      ["5511999998888", "https://l/phone"],
      ["21988887777", "https://l/legado"],
    ]),
  };

  it("CPF tem prioridade (contato existente com outro telefone)", () => {
    expect(resolveUtmLink(maps, { cpf: "123.456.789-01", phone_normalized: "5531900000000" })).toBe("https://l/cpf");
  });
  it("telefone do contato com DDI casa com a chave nova", () => {
    expect(resolveUtmLink(maps, { phone_normalized: "5511999998888" })).toBe("https://l/phone");
  });
  it("linha antiga gravada sem o 55 ainda casa", () => {
    expect(resolveUtmLink(maps, { phone_normalized: "5521988887777" })).toBe("https://l/legado");
  });
  it("sem link vira vazio", () => {
    expect(resolveUtmLink(maps, { cpf: null, phone_normalized: "5599999999999" })).toBe("");
    expect(resolveUtmLink(maps, {})).toBe("");
  });
});
