// Qual pedaço do conhecimento entra no contexto (TASK1-D): busca vetorial com mock e queda para o modo atual.
import { describe, expect, it, vi } from "vitest";

import { buildKnowledgeBaseContext } from "@/lib/ai/kb-context";
import { buildAgentKnowledgeContext, formatVectorContext, type VectorRetriever } from "./knowledge-context";

const FILES = [
  { id: "f1", name: "Política de descontos", content: "Desconto de 40% à vista para dívidas antigas." },
  { id: "f2", name: "Horários", content: "Atendimento das 8h às 18h." },
];
const QUERY = "tem desconto à vista?";
const lexical = buildKnowledgeBaseContext(FILES, QUERY, 40000);

const base = { accountId: "acc", files: FILES, query: QUERY, maxChars: 40000 };

describe("buildAgentKnowledgeContext", () => {
  it("busca desligada (ou sem agente): exatamente o modo atual, sem chamar a busca", async () => {
    const retrieve = vi.fn<VectorRetriever>();
    expect(await buildAgentKnowledgeContext({ ...base, vector: undefined, retrieve })).toEqual({ context: lexical, mode: "lexical" });
    expect(await buildAgentKnowledgeContext({ ...base, vector: { enabled: false }, retrieve })).toEqual({ context: lexical, mode: "lexical" });
    expect(await buildAgentKnowledgeContext({ ...base, vector: { enabled: true }, retrieve: null })).toEqual({ context: lexical, mode: "lexical" });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("ligada: injeta os trechos mais próximos no lugar do conhecimento inteiro, com os parâmetros do agente", async () => {
    const retrieve = vi.fn<VectorRetriever>(async () => [
      { file_id: "f1", chunk_index: 0, content: "Desconto de 40% à vista", similarity: 0.82 },
    ]);
    let t = 1000;
    const out = await buildAgentKnowledgeContext({
      ...base,
      vector: { enabled: true, top_k: 3, min_similarity: 0.5 },
      retrieve,
      now: () => (t += 120),
    });
    expect(retrieve).toHaveBeenCalledWith({ accountId: "acc", fileIds: ["f1", "f2"], query: QUERY, topK: 3, minSimilarity: 0.5 });
    expect(out).toEqual({
      context: "[ARQUIVO: Política de descontos — trecho 1]\nDesconto de 40% à vista\n---",
      mode: "vector",
      vectorMs: 120,
      hits: 1,
    });
    expect(out.context).not.toContain("Horários");
  });

  it("padrões: top_k 6 e similaridade mínima 0,3", async () => {
    const retrieve = vi.fn<VectorRetriever>(async () => []);
    await buildAgentKnowledgeContext({ ...base, vector: { enabled: true }, retrieve });
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ topK: 6, minSimilarity: 0.3 }));
  });

  it.each([
    ["sem trechos acima da similaridade mínima", async () => [], "no_hits"],
    ["erro (sem chave, arquivo sem índice, banco)", async () => Promise.reject(new Error("sem índice")), "error"],
  ] as const)("%s: cai no modo atual", async (_label, impl, fallback) => {
    const out = await buildAgentKnowledgeContext({ ...base, vector: { enabled: true }, retrieve: vi.fn<VectorRetriever>(impl) });
    expect(out.context).toBe(lexical);
    expect(out.mode).toBe("lexical");
    expect(out.fallback).toBe(fallback);
  });

  it("tempo esgotado: cai no modo atual sem esperar a busca", async () => {
    const out = await buildAgentKnowledgeContext({
      ...base,
      vector: { enabled: true },
      retrieve: () => new Promise(() => undefined),
      budgetMs: 20,
    });
    expect(out).toMatchObject({ context: lexical, mode: "lexical", fallback: "timeout" });
  });

  it("mensagem vazia não consulta; sem arquivos não há bloco", async () => {
    const retrieve = vi.fn<VectorRetriever>();
    expect((await buildAgentKnowledgeContext({ ...base, query: "  ", vector: { enabled: true }, retrieve })).fallback).toBe("no_query");
    expect(await buildAgentKnowledgeContext({ ...base, files: [], vector: { enabled: true }, retrieve })).toEqual({ context: undefined, mode: "none" });
    expect(retrieve).not.toHaveBeenCalled();
  });
});

describe("formatVectorContext", () => {
  it("respeita o teto de caracteres (o primeiro trecho é cortado se sozinho não couber)", () => {
    const hits = [
      { file_id: "f1", chunk_index: 2, content: "A".repeat(50), similarity: 0.9 },
      { file_id: "f2", chunk_index: 0, content: "B".repeat(50), similarity: 0.8 },
    ];
    const one = formatVectorContext(hits, FILES, 100);
    expect(one).toContain("trecho 3");
    expect(one).not.toContain("B");
    expect(formatVectorContext(hits, FILES, 30)).toHaveLength(30);
  });
});
