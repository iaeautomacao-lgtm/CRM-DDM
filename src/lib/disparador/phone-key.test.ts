import { describe, expect, it } from "vitest";
import { formatBrazilianPhone, phoneKey, phoneVariants } from "./phone-key";

describe("formatBrazilianPhone", () => {
  it("põe +55 quando falta e mantém quando já tem", () => {
    expect(formatBrazilianPhone("11 99999-8888")).toBe("+5511999998888");
    expect(formatBrazilianPhone("+55 (11) 99999-8888")).toBe("+5511999998888");
    expect(formatBrazilianPhone("")).toBe("");
  });
});

describe("phoneKey", () => {
  it("iguala formatos e o 9º dígito", () => {
    const k = phoneKey("+5511999998888");
    expect(phoneKey("11999998888")).toBe(k);
    expect(phoneKey("+11999998888")).toBe(k); // entrada manual antiga, sem 55
    expect(phoneKey("+551199998888")).toBe(k); // sem o 9º dígito
    expect(phoneKey("+5521999998888")).not.toBe(k); // outro DDD
  });
});

describe("phoneVariants", () => {
  it("inclui as formas antigas gravadas na blacklist", () => {
    const v = phoneVariants("+5511999998888");
    expect(v).toContain("+5511999998888");
    expect(v).toContain("+11999998888");
    expect(v).toContain("+551199998888");
  });
  it("número fora do padrão BR só ele mesmo", () => {
    expect(phoneVariants("+1415555")).toEqual(["+1415555"]);
  });
});
