// RAG vetorial dos agentes (TASK1-D), SÓ no servidor: embeddings com a chave de IA DA CONTA, indexação dos
// arquivos de conhecimento em wacrm.knowledge_chunks e busca top_k (wacrm.match_knowledge_chunks, migration 215).
//
// Chave: ai_config.api_key da conta (cifrada; migration 084) quando o provedor da conta é OpenAI. Nunca a chave
// da plataforma (.env): sem chave da conta, o arquivo fica "sem índice" e vale o modo atual.
// Custo: cada chamada de embeddings soma em wacrm.ai_embedding_usage (conta × dia).

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { tryDecrypt } from "@/lib/whatsapp/encryption";
import { chunkText, KB_MAX_CHUNKS_PER_FILE } from "./chunk";
import type { VectorHit, VectorRetriever } from "./knowledge-context";

type Db = Pick<SupabaseClient, "from" | "rpc">;

export const EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
/** Textos por chamada de embeddings na indexação. */
const EMBED_BATCH = 64;
/** Linhas por insert de trechos. */
const INSERT_BATCH = 100;
const INDEX_CALL_TIMEOUT_MS = 30_000;
/** Teto de tempo de uma indexação (fora do turno da IA). Estourou → "failed" e vale o modo atual. */
const INDEX_BUDGET_MS = 90_000;
const QUERY_CALL_TIMEOUT_MS = 2_500;

export type EmbeddingStatus = "pending" | "indexed" | "no_key" | "failed" | "too_large";

export class EmbeddingError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/** Chave de IA da conta para embeddings (só provedor OpenAI). null = sem chave da conta. */
export async function loadAccountEmbeddingKey(db: Db, accountId: string): Promise<string | null> {
  const { data, error } = await db.from("ai_config").select("api_provider, api_key").eq("account_id", accountId).limit(1);
  if (error) throw new EmbeddingError(`ai_config: ${error.message}`);
  const row = ((data ?? []) as Array<{ api_provider: string | null; api_key: string | null }>)[0];
  if (!row || row.api_provider !== "openai") return null;
  const raw = row.api_key?.trim();
  if (!raw) return null;
  const key = tryDecrypt(raw).trim();
  return key || null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Embeddings de vários textos numa chamada. Erro HTTP/rede/formato → EmbeddingError (sem expor a chave). */
export async function createEmbeddings(
  apiKey: string,
  inputs: string[],
  options: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<{ vectors: number[][]; tokens: number }> {
  const doFetch = options.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let res: Response;
  try {
    res = await doFetch(EMBEDDINGS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
      signal: AbortSignal.timeout(options.timeoutMs ?? INDEX_CALL_TIMEOUT_MS),
    });
  } catch {
    throw new EmbeddingError("Falha de rede ao gerar embeddings.");
  }
  if (!res.ok) throw new EmbeddingError(`Embeddings recusados (HTTP ${res.status}).`, res.status);
  const body = (await res.json().catch(() => null)) as {
    data?: Array<{ index: number; embedding: number[] }>;
    usage?: { total_tokens?: number };
  } | null;
  const rows = body?.data;
  if (!Array.isArray(rows) || rows.length !== inputs.length) throw new EmbeddingError("Resposta de embeddings inválida.");
  const vectors = new Array<number[]>(inputs.length);
  for (const row of rows) {
    if (!Array.isArray(row.embedding) || row.embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingError("Embedding com dimensão inesperada.");
    }
    vectors[row.index] = row.embedding;
  }
  if (vectors.some((v) => !v)) throw new EmbeddingError("Resposta de embeddings incompleta.");
  return { vectors, tokens: body?.usage?.total_tokens ?? 0 };
}

/** Formato de entrada do tipo vector no Postgres. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

/** Soma o uso de embeddings da conta (contagem simples para o dono). Nunca lança. */
export async function recordEmbeddingUsage(db: Db, accountId: string, embeddings: number, tokens: number): Promise<void> {
  try {
    const { error } = await db.rpc("ai_embedding_usage_add", {
      p_account_id: accountId,
      p_embeddings: embeddings,
      p_tokens: tokens,
    });
    if (error) console.error("[kb-vector] falha ao registrar uso de embeddings:", error.message);
  } catch (err) {
    console.error("[kb-vector] falha ao registrar uso de embeddings:", err instanceof Error ? err.message : err);
  }
}

async function setFileStatus(db: Db, accountId: string, fileId: string, patch: Record<string, unknown>) {
  const { error } = await db.from("knowledge_base_files").update(patch).eq("account_id", accountId).eq("id", fileId);
  if (error) console.error("[kb-vector] falha ao gravar a situação do índice:", error.message);
}

async function deleteChunks(db: Db, accountId: string, fileId: string) {
  const { error } = await db.from("knowledge_chunks").delete().eq("account_id", accountId).eq("file_id", fileId);
  if (error) throw new EmbeddingError(`knowledge_chunks: ${error.message}`);
}

export interface IndexDeps {
  db: Db;
  loadKey?: (db: Db, accountId: string) => Promise<string | null>;
  embed?: typeof createEmbeddings;
  now?: () => number;
}

/**
 * (Re)indexa um arquivo: apaga os trechos antigos, divide o texto, gera os embeddings em blocos com a chave da
 * conta e grava os trechos. Fora do turno da IA (no upload/reindexação), com teto de trechos e de tempo. Nunca
 * lança: o resultado vai para knowledge_base_files.embedding_status e, sem índice, vale o modo atual.
 */
export async function indexKnowledgeFile(
  deps: IndexDeps,
  accountId: string,
  fileId: string,
  text: string,
): Promise<{ status: EmbeddingStatus; chunks: number; ms: number }> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const started = now();
  const done = async (status: EmbeddingStatus, chunks = 0) => {
    await setFileStatus(db, accountId, fileId, {
      embedding_status: status,
      embedding_chunks: status === "indexed" ? chunks : null,
      embedding_model: status === "indexed" ? EMBEDDING_MODEL : null,
      embedded_at: status === "indexed" ? new Date().toISOString() : null,
    });
    return { status, chunks, ms: now() - started };
  };

  try {
    await setFileStatus(db, accountId, fileId, { embedding_status: "pending" });
    await deleteChunks(db, accountId, fileId);
    const key = await (deps.loadKey ?? loadAccountEmbeddingKey)(db, accountId);
    if (!key) return await done("no_key");
    const chunks = chunkText(text);
    if (chunks.length === 0) return await done("failed");
    if (chunks.length > KB_MAX_CHUNKS_PER_FILE) return await done("too_large");

    const embed = deps.embed ?? createEmbeddings;
    let embedded = 0;
    let tokens = 0;
    try {
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        if (now() - started > INDEX_BUDGET_MS) throw new EmbeddingError("Tempo de indexação esgotado.");
        const batch = chunks.slice(i, i + EMBED_BATCH);
        const out = await embed(key, batch.map((c) => c.content), { timeoutMs: INDEX_CALL_TIMEOUT_MS });
        embedded += batch.length;
        tokens += out.tokens;
        const rows = batch.map((c, j) => ({
          account_id: accountId,
          file_id: fileId,
          chunk_index: c.index,
          content: c.content,
          token_estimate: c.tokenEstimate,
          embedding: toVectorLiteral(out.vectors[j]),
          model: EMBEDDING_MODEL,
        }));
        for (let k = 0; k < rows.length; k += INSERT_BATCH) {
          const { error } = await db.from("knowledge_chunks").insert(rows.slice(k, k + INSERT_BATCH));
          if (error) throw new EmbeddingError(`knowledge_chunks: ${error.message}`);
        }
      }
    } finally {
      if (embedded > 0) await recordEmbeddingUsage(db, accountId, embedded, tokens);
    }
    return await done("indexed", chunks.length);
  } catch (err) {
    console.error("[kb-vector] falha ao indexar arquivo:", err instanceof Error ? err.message : err);
    // Índice parcial não pode valer: apaga o que entrou.
    await deleteChunks(db, accountId, fileId).catch(() => undefined);
    return done("failed");
  }
}

export interface RetrieverDeps {
  db: Db;
  loadKey?: (db: Db, accountId: string) => Promise<string | null>;
  embed?: typeof createEmbeddings;
}

/**
 * Busca real (responder e simulador): só vale se TODOS os arquivos do agente estão indexados; senão lança e o
 * chamador cai no modo atual (não mistura arquivo com e sem índice). Embedding da mensagem com a chave da conta,
 * depois os top_k trechos mais próximos da conta e desses arquivos.
 */
export function createVectorRetriever(deps: RetrieverDeps): VectorRetriever {
  return async ({ accountId, fileIds, query, topK, minSimilarity }) => {
    const { db } = deps;
    for (let i = 0; i < fileIds.length; i += 100) {
      const ids = fileIds.slice(i, i + 100);
      const { data, error } = await db
        .from("knowledge_base_files")
        .select("id, embedding_status")
        .eq("account_id", accountId)
        .in("id", ids);
      if (error) throw new EmbeddingError(`knowledge_base_files: ${error.message}`);
      const rows = (data ?? []) as Array<{ id: string; embedding_status: string | null }>;
      if (rows.length !== ids.length || rows.some((r) => r.embedding_status !== "indexed")) {
        throw new EmbeddingError("Há arquivo sem índice.");
      }
    }
    const key = await (deps.loadKey ?? loadAccountEmbeddingKey)(db, accountId);
    if (!key) throw new EmbeddingError("Conta sem chave de IA para embeddings.");
    const out = await (deps.embed ?? createEmbeddings)(key, [query.slice(0, 8000)], { timeoutMs: QUERY_CALL_TIMEOUT_MS });
    void recordEmbeddingUsage(db, accountId, 1, out.tokens);
    const { data, error } = await db.rpc("match_knowledge_chunks", {
      p_account_id: accountId,
      p_file_ids: fileIds,
      p_query: toVectorLiteral(out.vectors[0]),
      p_top_k: topK,
      p_min_similarity: minSimilarity,
    });
    if (error) throw new EmbeddingError(`match_knowledge_chunks: ${error.message}`);
    return (data ?? []) as VectorHit[];
  };
}
