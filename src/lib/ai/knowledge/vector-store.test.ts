// RAG vetorial (TASK1-D): chave da conta, embeddings, indexação e busca — com banco e HTTP falsos.
import { describe, expect, it, vi } from "vitest";

import { encrypt } from "@/lib/whatsapp/encryption";
import { KB_MAX_CHUNKS_PER_FILE } from "./chunk";
import {
  createEmbeddings,
  createVectorRetriever,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  indexKnowledgeFile,
  loadAccountEmbeddingKey,
  toVectorLiteral,
} from "./vector-store";

type Op = { table: string; op: string; args: unknown[] };

/** Banco falso: registra as operações e responde por tabela. */
function fakeDb(responses: Record<string, unknown[] | ((op: Op[]) => unknown[])> = {}, errors: Record<string, string> = {}) {
  const ops: Op[] = [];
  const rpcs: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcResult = { data: [] as unknown[], error: null as { message: string } | null };
  const db = {
    from(table: string) {
      const mine: Op[] = [];
      const b: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "limit", "update", "delete", "insert", "order", "range"]) {
        b[op] = (...args: unknown[]) => {
          const entry = { table, op, args };
          ops.push(entry);
          mine.push(entry);
          return b;
        };
      }
      b.then = (resolve: (v: unknown) => unknown) => {
        const key = `${table}.${mine.find((o) => ["select", "update", "delete", "insert"].includes(o.op))?.op}`;
        if (errors[key]) return resolve({ data: null, error: { message: errors[key] } });
        const r = responses[key];
        return resolve({ data: typeof r === "function" ? r(mine) : (r ?? []), error: null });
      };
      return b;
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcs.push({ name, args });
      return Promise.resolve(name === "match_knowledge_chunks" ? rpcResult : { data: null, error: null });
    },
  };
  return { db: db as never, ops, rpcs, rpcResult };
}

const vec = (seed: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? seed : 0));
const fakeEmbed = vi.fn(async (_key: string, inputs: string[]) => ({ vectors: inputs.map((_, i) => vec(i)), tokens: inputs.length * 10 }));

describe("loadAccountEmbeddingKey — chave DA CONTA, nunca a do .env", () => {
  it("OpenAI com chave cifrada → decifra; outro provedor ou sem chave → null", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-plataforma");
    expect(await loadAccountEmbeddingKey(fakeDb({ "ai_config.select": [{ api_provider: "openai", api_key: encrypt("sk-conta") }] }).db, "acc")).toBe("sk-conta");
    expect(await loadAccountEmbeddingKey(fakeDb({ "ai_config.select": [{ api_provider: "gemini", api_key: encrypt("g") }] }).db, "acc")).toBeNull();
    expect(await loadAccountEmbeddingKey(fakeDb({ "ai_config.select": [{ api_provider: "openai", api_key: "" }] }).db, "acc")).toBeNull();
    expect(await loadAccountEmbeddingKey(fakeDb({ "ai_config.select": [] }).db, "acc")).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("createEmbeddings", () => {
  it("chama o endpoint com o modelo e devolve os vetores na ordem e os tokens", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ model: EMBEDDING_MODEL, input: ["a", "b"] });
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-conta");
      return new Response(JSON.stringify({ data: [{ index: 1, embedding: vec(2) }, { index: 0, embedding: vec(1) }], usage: { total_tokens: 7 } }));
    });
    const out = await createEmbeddings("sk-conta", ["a", "b"], { fetchImpl });
    expect(out.tokens).toBe(7);
    expect(out.vectors.map((v) => v[0])).toEqual([1, 2]);
  });

  it("HTTP de erro, dimensão errada ou rede → EmbeddingError sem expor a chave", async () => {
    const http = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(createEmbeddings("sk-conta", ["a"], { fetchImpl: http })).rejects.toThrow("Embeddings recusados (HTTP 401).");
    const dims = vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] })));
    await expect(createEmbeddings("sk-conta", ["a"], { fetchImpl: dims })).rejects.toThrow(/dimensão/);
    const net = vi.fn(async () => Promise.reject(new Error("ECONNRESET sk-conta")));
    await expect(createEmbeddings("sk-conta", ["a"], { fetchImpl: net })).rejects.toThrow("Falha de rede ao gerar embeddings.");
  });

  it("toVectorLiteral no formato do pgvector", () => {
    expect(toVectorLiteral([0.1, -2, 3])).toBe("[0.1,-2,3]");
  });
});

describe("indexKnowledgeFile", () => {
  const text = Array.from({ length: 1500 }, (_, i) => `palavra${i}`).join(" ");

  it("indexa em blocos: apaga os trechos antigos, grava os novos, marca indexed e soma o uso da conta", async () => {
    const f = fakeDb();
    fakeEmbed.mockClear();
    const out = await indexKnowledgeFile({ db: f.db, loadKey: async () => "sk-conta", embed: fakeEmbed }, "acc", "file-1", text);
    expect(out.status).toBe("indexed");
    expect(out.chunks).toBeGreaterThan(1);
    expect(fakeEmbed).toHaveBeenCalledWith("sk-conta", expect.any(Array), expect.anything());
    const deletes = f.ops.filter((o) => o.table === "knowledge_chunks" && o.op === "delete");
    expect(deletes).toHaveLength(1);
    const inserted = f.ops.filter((o) => o.table === "knowledge_chunks" && o.op === "insert").flatMap((o) => o.args[0] as Array<Record<string, unknown>>);
    expect(inserted).toHaveLength(out.chunks);
    expect(inserted[0]).toMatchObject({ account_id: "acc", file_id: "file-1", chunk_index: 0, model: EMBEDDING_MODEL });
    expect(String(inserted[0].embedding).startsWith("[0,")).toBe(true);
    const updates = f.ops.filter((o) => o.table === "knowledge_base_files" && o.op === "update").map((o) => o.args[0]);
    expect(updates[0]).toEqual({ embedding_status: "pending" });
    expect(updates.at(-1)).toMatchObject({ embedding_status: "indexed", embedding_chunks: out.chunks, embedding_model: EMBEDDING_MODEL });
    expect(f.rpcs).toEqual([{ name: "ai_embedding_usage_add", args: { p_account_id: "acc", p_embeddings: out.chunks, p_tokens: out.chunks * 10 } }]);
  });

  it("sem chave da conta → no_key, nada enviado ao provedor", async () => {
    const f = fakeDb();
    fakeEmbed.mockClear();
    const out = await indexKnowledgeFile({ db: f.db, loadKey: async () => null, embed: fakeEmbed }, "acc", "file-1", text);
    expect(out.status).toBe("no_key");
    expect(fakeEmbed).not.toHaveBeenCalled();
    expect(f.ops.some((o) => o.table === "knowledge_chunks" && o.op === "insert")).toBe(false);
  });

  it("falha no provedor → failed, apaga o índice parcial", async () => {
    const f = fakeDb();
    const embed = vi.fn(async () => Promise.reject(new Error("HTTP 500")));
    const out = await indexKnowledgeFile({ db: f.db, loadKey: async () => "sk", embed }, "acc", "file-1", text);
    expect(out.status).toBe("failed");
    expect(f.ops.filter((o) => o.table === "knowledge_chunks" && o.op === "delete")).toHaveLength(2);
  });

  it("acima do teto de trechos → too_large, sem gastar embeddings", async () => {
    const f = fakeDb();
    fakeEmbed.mockClear();
    const huge = "palavra ".repeat((KB_MAX_CHUNKS_PER_FILE + 5) * 800);
    const out = await indexKnowledgeFile({ db: f.db, loadKey: async () => "sk", embed: fakeEmbed }, "acc", "file-1", huge);
    expect(out.status).toBe("too_large");
    expect(fakeEmbed).not.toHaveBeenCalled();
  });
});

describe("createVectorRetriever", () => {
  it("todos os arquivos indexados: embedding da mensagem com a chave da conta e busca só na conta e nos arquivos", async () => {
    const f = fakeDb({ "knowledge_base_files.select": [{ id: "f1", embedding_status: "indexed" }, { id: "f2", embedding_status: "indexed" }] });
    f.rpcResult.data = [{ file_id: "f1", chunk_index: 0, content: "x", similarity: 0.9 }];
    const retrieve = createVectorRetriever({ db: f.db, loadKey: async () => "sk-conta", embed: fakeEmbed });
    const hits = await retrieve({ accountId: "acc", fileIds: ["f1", "f2"], query: "desconto", topK: 4, minSimilarity: 0.3 });
    expect(hits).toHaveLength(1);
    const match = f.rpcs.find((r) => r.name === "match_knowledge_chunks")!;
    expect(match.args).toMatchObject({ p_account_id: "acc", p_file_ids: ["f1", "f2"], p_top_k: 4, p_min_similarity: 0.3 });
    expect(String(match.args.p_query).startsWith("[0,")).toBe(true);
    expect(f.ops.some((o) => o.table === "knowledge_base_files" && o.op === "eq" && o.args[0] === "account_id" && o.args[1] === "acc")).toBe(true);
  });

  it("algum arquivo sem índice (ou de outra conta) → lança, para o chamador cair no modo atual", async () => {
    const pending = fakeDb({ "knowledge_base_files.select": [{ id: "f1", embedding_status: "indexed" }, { id: "f2", embedding_status: null }] });
    await expect(
      createVectorRetriever({ db: pending.db, loadKey: async () => "sk", embed: fakeEmbed })({ accountId: "acc", fileIds: ["f1", "f2"], query: "q", topK: 4, minSimilarity: 0 }),
    ).rejects.toThrow(/sem índice/);
    const missing = fakeDb({ "knowledge_base_files.select": [{ id: "f1", embedding_status: "indexed" }] });
    await expect(
      createVectorRetriever({ db: missing.db, loadKey: async () => "sk", embed: fakeEmbed })({ accountId: "acc", fileIds: ["f1", "f2"], query: "q", topK: 4, minSimilarity: 0 }),
    ).rejects.toThrow(/sem índice/);
    expect(missing.rpcs).toEqual([]);
  });

  it("sem chave da conta → lança sem chamar o provedor nem a busca", async () => {
    const f = fakeDb({ "knowledge_base_files.select": [{ id: "f1", embedding_status: "indexed" }] });
    fakeEmbed.mockClear();
    await expect(
      createVectorRetriever({ db: f.db, loadKey: async () => null, embed: fakeEmbed })({ accountId: "acc", fileIds: ["f1"], query: "q", topK: 4, minSimilarity: 0 }),
    ).rejects.toThrow(/sem chave/);
    expect(fakeEmbed).not.toHaveBeenCalled();
    expect(f.rpcs).toEqual([]);
  });
});
