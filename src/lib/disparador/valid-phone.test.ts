import { describe, expect, it } from "vitest";
import { hasDialablePhone } from "./valid-phone";

describe("hasDialablePhone", () => {
  it("exige pelo menos 10 dígitos", () => {
    expect(hasDialablePhone("+55 (11) 99999-8888")).toBe(true);
    expect(hasDialablePhone("1199998888")).toBe(true);
    expect(hasDialablePhone("119999888")).toBe(false);
    expect(hasDialablePhone("")).toBe(false);
    expect(hasDialablePhone(null)).toBe(false);
    expect(hasDialablePhone(undefined)).toBe(false);
    expect(hasDialablePhone("Seu debito vence 10/10")).toBe(false);
  });
});
