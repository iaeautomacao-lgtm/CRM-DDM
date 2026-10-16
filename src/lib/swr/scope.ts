import type { SwrScope } from "./keys";

/** Identificador do escopo (usuário + conta); null enquanto algum dos dois não resolveu. */
export function scopeId(scope: SwrScope | null): string | null {
  if (!scope?.accountId || !scope.userId) return null;
  return `${scope.userId}:${scope.accountId}`;
}

/**
 * O cache deve ser esvaziado quando havia um escopo e ele mudou ou sumiu
 * (troca de conta, troca de usuário, logout, sessão expirada). A primeira
 * resolução (null → escopo) não limpa: ainda não há nada de outro escopo.
 */
export function shouldClearOnScopeChange(prev: string | null, next: string | null): boolean {
  return prev !== null && prev !== next;
}
