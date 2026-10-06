import { describe, expect, it } from "vitest";
import { lineDiffStats, promptPreview } from "./prompt-diff";

describe("lineDiffStats", () => {
  it("textos iguais: nada mudou", () => {
    expect(lineDiffStats("a\nb", "a\nb")).toEqual({ added: 0, removed: 0 });
  });

  it("conta linhas adicionadas e removidas", () => {
    expect(lineDiffStats("a\nb\nc", "a\nB\nc\nd")).toEqual({ added: 2, removed: 1 });
    expect(lineDiffStats("", "x")).toEqual({ added: 1, removed: 1 });
  });

  it("ignora diferença de quebra de linha Windows", () => {
    expect(lineDiffStats("a\r\nb", "a\nb")).toEqual({ added: 0, removed: 0 });
  });

  it("textos grandes usam a comparação por conjunto", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `linha ${i}`).join("\n");
    expect(lineDiffStats(big, `${big}\nnova`)).toEqual({ added: 1, removed: 0 });
  });
});

describe("promptPreview", () => {
  it("achata espaços e corta", () => {
    expect(promptPreview("  Olá\n\n  mundo  ")).toBe("Olá mundo");
    expect(promptPreview("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
  });
});
