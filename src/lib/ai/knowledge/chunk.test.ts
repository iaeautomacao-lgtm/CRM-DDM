import { describe, expect, it } from "vitest";

import { CHARS_PER_TOKEN, chunkText, estimateTokens } from "./chunk";

describe("chunkText", () => {
  it("texto curto vira um trecho só", () => {
    expect(chunkText("  Olá, mundo.  ")).toEqual([{ index: 0, content: "Olá, mundo.", tokenEstimate: 3 }]);
    expect(chunkText("")).toEqual([]);
  });

  it("~800 tokens por trecho com ~100 de sobreposição, sem cortar palavra", () => {
    const words = Array.from({ length: 3000 }, (_, i) => `palavra${i}`);
    const text = words.join(" ");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(800 * CHARS_PER_TOKEN);
      // começa e termina em palavra inteira
      expect(words).toContain(c.content.split(" ")[0]);
      expect(words).toContain(c.content.split(" ").at(-1));
    }
    // sobreposição: o fim de um trecho reaparece no começo do seguinte
    for (let i = 1; i < chunks.length; i++) {
      const lastWord = chunks[i - 1].content.split(" ").at(-1)!;
      expect(chunks[i].content.includes(lastWord)).toBe(true);
    }
    // cobre o texto inteiro
    expect(chunks.at(-1)!.content.endsWith("palavra2999")).toBe(true);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("prefere cortar no parágrafo", () => {
    const para = "a".repeat(2500);
    const chunks = chunkText(`${para}\n\n${"b".repeat(2500)}`);
    expect(chunks[0].content).toBe(para);
  });

  it("estimateTokens ≈ caracteres / 4", () => {
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });
});
