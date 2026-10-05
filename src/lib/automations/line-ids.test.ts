import { describe, expect, it } from "vitest";
import { parseLineIds } from "./line-ids";

const A = "11111111-2222-4333-8444-555555555555";
const B = "99999999-2222-4333-8444-555555555555";

describe("parseLineIds", () => {
  it("vazio/ausente = todas as linhas", () => {
    expect(parseLineIds(undefined)).toEqual([]);
    expect(parseLineIds(null)).toEqual([]);
    expect(parseLineIds([])).toEqual([]);
  });
  it("remove duplicadas", () => {
    expect(parseLineIds([A, B, A])).toEqual([A, B]);
  });
  it("rejeita formato inválido", () => {
    expect(parseLineIds("abc")).toBeNull();
    expect(parseLineIds([A, "x"])).toBeNull();
    expect(parseLineIds([1])).toBeNull();
    expect(parseLineIds(Array.from({ length: 51 }, () => A))).toBeNull();
  });
});
