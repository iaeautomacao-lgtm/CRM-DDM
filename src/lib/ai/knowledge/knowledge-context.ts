// Qual pedaço do conhecimento entra no contexto do agente (TASK1-D). Módulo puro: a busca vetorial vem de fora
// (VectorRetriever), o que deixa o mesmo caminho para o responder e para o simulador e permite testar com mock.
//
// knowledge.vector.enabled e um retriever disponível → os top_k trechos mais próximos do que o cliente disse,
// dentro do teto de caracteres. Qualquer outra coisa — desligado, sem chave, arquivo sem índice, nenhum trecho
// acima da similaridade mínima, erro ou tempo esgotado — cai no MODO ATUAL (buildKnowledgeBaseContext, teto de
// caracteres). Nunca lança: a resposta do agente nunca cai por causa da busca.
// Não muda prompt nem texto da operação: só o conteúdo do bloco de conhecimento.

import { buildKnowledgeBaseContext } from "@/lib/ai/kb-context";

export const VECTOR_DEFAULT_TOP_K = 6;
export const VECTOR_DEFAULT_MIN_SIMILARITY = 0.3;
/** Orçamento da busca no turno (embedding da mensagem + consulta). Estourou → modo atual. */
export const VECTOR_BUDGET_MS = 3000;

export interface VectorHit {
  file_id: string;
  chunk_index: number;
  content: string;
  similarity: number;
}

export type VectorRetriever = (args: {
  accountId: string;
  fileIds: string[];
  query: string;
  topK: number;
  minSimilarity: number;
}) => Promise<VectorHit[]>;

export interface VectorSettings {
  enabled: boolean;
  top_k?: number;
  min_similarity?: number;
}

export interface KnowledgeContextResult {
  context: string | undefined;
  mode: "vector" | "lexical" | "none";
  /** Tempo da tentativa vetorial (ms), quando houve. */
  vectorMs?: number;
  /** Por que caiu no modo atual (quando tentou o vetorial). */
  fallback?: "no_query" | "no_hits" | "error" | "timeout";
  hits?: number;
}

type KbFile = { id?: string; name: string; content: string | null };

class VectorTimeout extends Error {}

function withBudget<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new VectorTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Trechos mais próximos primeiro, no mesmo formato de bloco do modo atual, até o teto de caracteres. */
export function formatVectorContext(hits: VectorHit[], files: KbFile[], maxChars: number): string {
  const names = new Map(files.filter((f) => f.id).map((f) => [f.id as string, f.name]));
  const parts: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const block = `[ARQUIVO: ${names.get(hit.file_id) ?? "arquivo"} — trecho ${hit.chunk_index + 1}]\n${hit.content}\n---`;
    const sep = parts.length > 0 ? 2 : 0;
    if (used + sep + block.length > maxChars) {
      if (parts.length === 0) parts.push(block.slice(0, maxChars));
      break;
    }
    parts.push(block);
    used += sep + block.length;
  }
  return parts.join("\n\n");
}

export async function buildAgentKnowledgeContext(input: {
  accountId: string;
  /** Arquivos já filtrados pela seleção do agente. */
  files: KbFile[];
  /** Texto recente do cliente (mesma consulta do modo atual). */
  query: string;
  maxChars: number | undefined;
  vector: VectorSettings | undefined;
  retrieve: VectorRetriever | null | undefined;
  budgetMs?: number;
  now?: () => number;
}): Promise<KnowledgeContextResult> {
  const { files, query, maxChars } = input;
  if (files.length === 0) return { context: undefined, mode: "none" };
  const lexical = (extra: Partial<KnowledgeContextResult> = {}): KnowledgeContextResult => ({
    context: buildKnowledgeBaseContext(files, query, maxChars),
    mode: "lexical",
    ...extra,
  });

  const fileIds = files.map((f) => f.id).filter((id): id is string => typeof id === "string");
  if (!input.vector?.enabled || !input.retrieve || fileIds.length === 0) return lexical();
  if (!query.trim()) return lexical({ fallback: "no_query" });

  const now = input.now ?? Date.now;
  const started = now();
  try {
    const hits = await withBudget(
      input.retrieve({
        accountId: input.accountId,
        fileIds,
        query,
        topK: input.vector.top_k ?? VECTOR_DEFAULT_TOP_K,
        minSimilarity: input.vector.min_similarity ?? VECTOR_DEFAULT_MIN_SIMILARITY,
      }),
      input.budgetMs ?? VECTOR_BUDGET_MS,
    );
    const vectorMs = now() - started;
    if (hits.length === 0) return lexical({ vectorMs, fallback: "no_hits", hits: 0 });
    return {
      context: formatVectorContext(hits, files, maxChars ?? Number.POSITIVE_INFINITY),
      mode: "vector",
      vectorMs,
      hits: hits.length,
    };
  } catch (err) {
    return lexical({ vectorMs: now() - started, fallback: err instanceof VectorTimeout ? "timeout" : "error" });
  }
}
