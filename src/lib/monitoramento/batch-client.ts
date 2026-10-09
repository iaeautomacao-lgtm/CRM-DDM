// Cliente das ações em lote do Monitoramento (Cinzel): POST /api/monitoramento/lote/transferir-para-mim e /finalizar.
// O servidor aceita de 1 a 50 ids por chamada; aqui a seleção é dividida em blocos de 50 (em sequência) e os resultados
// por item são juntados. `already_mine` conta como ok, mas não deve disparar a mensagem de "assumi o atendimento".

export const BATCH_MAX_IDS = 50;

export type BatchItemCode = "not_found" | "already_mine" | "error";

export interface BatchItemResult {
  conversation_id: string;
  ok: boolean;
  code?: BatchItemCode;
  error?: string;
}

export interface BatchSummary {
  total: number;
  ok: number;
  failed: number;
}

export interface BatchOutcome {
  summary: BatchSummary;
  results: BatchItemResult[];
}

export function chunk<T>(items: readonly T[], size: number = BATCH_MAX_IDS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Junta os resultados de vários blocos; o resumo é recontado a partir dos itens. */
export function mergeBatches(parts: ReadonlyArray<BatchOutcome>): BatchOutcome {
  const results = parts.flatMap((p) => p.results);
  const ok = results.filter((r) => r.ok).length;
  return { summary: { total: results.length, ok, failed: results.length - ok }, results };
}

/** Itens que mudaram de dono de verdade: ok e que não eram já do usuário (só esses recebem a mensagem de assumir). */
export function newlyAssigned(results: ReadonlyArray<BatchItemResult>): string[] {
  return results.filter((r) => r.ok && r.code !== "already_mine").map((r) => r.conversation_id);
}

export interface PostBatchOptions {
  /** fetch com a sessão do app (apiFetch). */
  fetcher: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Erro de uma chamada inteira (413, 400, 403…): a mensagem do servidor, sem detalhe técnico. */
export class BatchRequestError extends Error {}

async function postBlock(
  { fetcher }: PostBatchOptions,
  path: string,
  body: Record<string, unknown>,
  ids: string[],
): Promise<BatchOutcome> {
  const res = await fetcher(`/api/monitoramento/lote/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, conversation_ids: ids }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<BatchOutcome> & { error?: string };
  if (!res.ok || !data.results) {
    throw new BatchRequestError(typeof data.error === "string" ? data.error : "Não foi possível concluir a ação em lote.");
  }
  return { summary: data.summary ?? { total: data.results.length, ok: 0, failed: 0 }, results: data.results };
}

/**
 * Roda a ação nos blocos de 50, em sequência. Se um bloco falha por inteiro (rede, permissão), os blocos anteriores já
 * valeram: o que foi feito é devolvido em `done` e os ids que ficaram sem resposta, em `pending`.
 */
export async function runBatch(
  opts: PostBatchOptions,
  path: "transferir-para-mim" | "finalizar",
  body: Record<string, unknown>,
  ids: readonly string[],
): Promise<{ done: BatchOutcome; pending: string[]; error: string | null }> {
  const parts: BatchOutcome[] = [];
  const blocks = chunk(ids);
  for (let i = 0; i < blocks.length; i++) {
    try {
      parts.push(await postBlock(opts, path, body, blocks[i]));
    } catch (err) {
      return {
        done: mergeBatches(parts),
        pending: blocks.slice(i).flat(),
        error: err instanceof Error ? err.message : "Não foi possível concluir a ação em lote.",
      };
    }
  }
  return { done: mergeBatches(parts), pending: [], error: null };
}
