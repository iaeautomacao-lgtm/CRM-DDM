// Helpers puros da paginação da lista do inbox.

/** Deve disparar o carregamento automático da próxima página? */
export function shouldAutoLoadMore(s: {
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  failed: boolean;
}): boolean {
  return Boolean(s.nextCursor) && !s.loading && !s.loadingMore && !s.failed;
}

/**
 * Total exibido no cabeçalho de uma seção. Com mais páginas por carregar o
 * total do servidor manda (nunca menor que o já carregado, que pode incluir
 * conversas chegadas pelo tempo real); sem mais páginas, o carregado é exato.
 */
export function sectionTotal(loaded: number, serverTotal: number | null | undefined, hasMore: boolean): number {
  if (!hasMore || serverTotal == null) return loaded;
  return Math.max(loaded, serverTotal);
}
