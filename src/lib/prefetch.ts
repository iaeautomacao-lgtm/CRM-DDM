// Pré-carrega uma tela quando a pessoa "demonstra intenção" (passa o mouse, foca com o teclado ou toca num link do menu): o JavaScript da
// próxima tela já vem enquanto ela decide clicar. Cada destino é pedido UMA vez só. Não muda comportamento: se o pedido falhar, o clique
// funciona normalmente.

/** Só o caminho (sem ?query/#âncora): é o que define qual tela (e qual JavaScript) carrega. */
export function prefetchPath(href: string): string {
  return href.split(/[?#]/)[0] || "/";
}

export function createPrefetcher(prefetch: (path: string) => void | Promise<void>) {
  const done = new Set<string>();
  return (href: string): boolean => {
    const path = prefetchPath(href);
    if (!path.startsWith("/") || done.has(path)) return false;
    done.add(path);
    try {
      void Promise.resolve(prefetch(path)).catch(() => done.delete(path));
    } catch {
      done.delete(path);
    }
    return true;
  };
}
