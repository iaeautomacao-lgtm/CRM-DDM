// Paginação por deslocamento (offset) para listas que carregam "mais" sob demanda.
// Busca `limit + 1` linhas para saber se existe próxima página sem um COUNT; o excedente é descartado.

export interface PageParams {
  limit: number;
  offset: number;
}

/**
 * Lê `limit` e `offset` da URL. Valor ausente ou inválido cai no padrão; `limit` é limitado ao máximo.
 * `defaultLimit: null` significa "sem paginação quando `limit` não vier" (compatibilidade com quem lista tudo).
 */
export function parsePageParams(
  sp: URLSearchParams,
  opts: { defaultLimit: number | null; maxLimit: number },
): { limit: number | null; offset: number } {
  const rawLimit = sp.get("limit");
  const rawOffset = sp.get("offset");
  const n = (v: string | null) => (v !== null && /^\d+$/.test(v) ? Number(v) : null);
  const l = n(rawLimit);
  const limit = l === null ? opts.defaultLimit : Math.min(Math.max(l, 1), opts.maxLimit);
  const offset = n(rawOffset) ?? 0;
  return { limit, offset };
}

/** Intervalo para `.range(from, to)` do PostgREST: uma linha a mais que o limite, para detectar `has_more`. */
export function pageRange({ limit, offset }: PageParams): [number, number] {
  return [offset, offset + limit];
}

/** Separa a página (até `limit` linhas) do aviso de que existe mais. */
export function splitPage<T>(rows: readonly T[], limit: number): { rows: T[]; hasMore: boolean } {
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
}
