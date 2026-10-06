import { describe, expect, it } from "vitest";
import { buildKnowledgeBaseContext, kbMaxChars, KB_DEFAULT_MAX_CHARS } from "./kb-context";

const f = (name: string, content: string) => ({ name, content });

describe("buildKnowledgeBaseContext", () => {
  it("abaixo do teto mantém o formato e a ordem de antes", () => {
    const out = buildKnowledgeBaseContext([f("a", "AAA"), f("b", "BBB")], "qualquer", 1000);
    expect(out).toBe("[ARQUIVO: a]\nAAA\n---\n\n[ARQUIVO: b]\nBBB\n---");
  });

  it("sem arquivos devolve vazio", () => {
    expect(buildKnowledgeBaseContext([], "x")).toBe("");
  });

  it("acima do teto escolhe os arquivos relevantes e respeita o tamanho", () => {
    const files = [
      f("Preços", "tabela de precos ".repeat(60)),
      f("Parcelamento", "regras de parcelamento do acordo ".repeat(60)),
      f("Endereço", "rua das flores ".repeat(60)),
    ];
    const max = 1500;
    const out = buildKnowledgeBaseContext(files, "quero saber sobre parcelamento", max);
    expect(out.length).toBeLessThanOrEqual(max);
    expect(out).toContain("[ARQUIVO: Parcelamento]");
    // ordem original preservada entre os escolhidos
    const idxA = out.indexOf("[ARQUIVO: Preços]");
    const idxB = out.indexOf("[ARQUIVO: Parcelamento]");
    if (idxA >= 0) expect(idxA).toBeLessThan(idxB);
  });

  it("trunca um arquivo único maior que o teto", () => {
    const out = buildKnowledgeBaseContext([f("grande", "x".repeat(5000))], "", 1000);
    expect(out.length).toBeLessThanOrEqual(1000);
    expect(out).toContain("trecho omitido");
  });

  it("teto configurável por env", () => {
    delete process.env.AI_KB_MAX_CHARS;
    expect(kbMaxChars()).toBe(KB_DEFAULT_MAX_CHARS);
    process.env.AI_KB_MAX_CHARS = "1234";
    expect(kbMaxChars()).toBe(1234);
    delete process.env.AI_KB_MAX_CHARS;
  });
});
