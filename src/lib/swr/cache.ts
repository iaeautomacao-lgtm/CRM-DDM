/**
 * Cache do SWR — SOMENTE em memória (LGPD).
 *
 * Regras fixas, cobertas por src/lib/swr/swr.test.ts:
 *  - nada aqui toca localStorage / sessionStorage / IndexedDB: a resposta de
 *    qualquer rota vive no heap da aba e morre com ela;
 *  - no servidor (SSR) cada chamada devolve um Map novo, para que um cache
 *    compartilhado do processo nunca misture usuários;
 *  - clearSwrCache() esvazia tudo (logout, troca de conta/usuário, sessão expirada).
 */

import { clearRetention } from "./retention";

// O SWR guarda estados internos de tipos variados no mesmo Map.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Store = Map<string, any>;

let browserStore: Store | null = null;

/** Map usado pelo SWRConfig `provider`. No navegador é um singleton por aba. */
export function getSwrCacheStore(): Store {
  if (typeof window === "undefined") return new Map();
  browserStore ??= new Map();
  return browserStore;
}

/** Esvazia todo o cache em memória (logout, troca de conta/usuário, sessão expirada). */
export function clearSwrCache(): void {
  browserStore?.clear();
  clearRetention();
}

/** Quantas entradas o cache tem agora — só para testes e diagnóstico. */
export function swrCacheSize(): number {
  return browserStore?.size ?? 0;
}
