/**
 * Chaves do cache SWR. Toda chave carrega, nesta ordem:
 *   ["ddm", accountId, userId, nome, ...parâmetros]
 * assim a troca de conta ou de usuário nunca reaproveita dado de outro escopo,
 * mesmo que a limpeza do cache atrasasse.
 *
 * Parâmetros aceitam só ids, números, booleanos e enums curtos. Dado pessoal
 * (e-mail, telefone, termo de busca, nome) NÃO entra em chave: o builder
 * recusa o que parece pessoal e quem precisa de busca livre não usa cache.
 */

export type SwrParam = string | number | boolean | null;

export interface SwrScope {
  accountId: string;
  userId: string;
}

export const SWR_KEY_PREFIX = "ddm" as const;

export type SwrKey = readonly [typeof SWR_KEY_PREFIX, string, string, string, ...SwrParam[]];

const MAX_PARAM_LENGTH = 200;
// e-mail, ou sequência longa de dígitos (telefone/CPF) fora de UUID.
const EMAIL_LIKE = /@/;
const PHONE_LIKE = /^\+?[\d\s().-]{8,}$/;

export function isSafeKeyParam(value: SwrParam): boolean {
  if (typeof value !== "string") return true;
  if (value.length > MAX_PARAM_LENGTH) return false;
  if (EMAIL_LIKE.test(value)) return false;
  if (PHONE_LIKE.test(value)) return false;
  return true;
}

/**
 * Monta a chave escopada. Devolve null (SWR não busca) enquanto não houver
 * conta e usuário resolvidos.
 */
export function buildSwrKey(
  scope: SwrScope | null,
  name: string,
  params: readonly SwrParam[] = [],
): SwrKey | null {
  if (!scope?.accountId || !scope.userId) return null;
  for (const p of [name, ...params]) {
    if (!isSafeKeyParam(p)) {
      throw new Error("[swr] parâmetro de chave com cara de dado pessoal: use só ids e enums.");
    }
  }
  return [SWR_KEY_PREFIX, scope.accountId, scope.userId, name, ...params];
}

export function isSwrKey(key: unknown): key is SwrKey {
  return Array.isArray(key) && key[0] === SWR_KEY_PREFIX && typeof key[1] === "string" && typeof key[2] === "string";
}

/** Casa chaves do SWR de um nome (qualquer parâmetro) — para invalidar após uma escrita. */
export function matchesSwrName(key: unknown, name: string): boolean {
  return isSwrKey(key) && key[3] === name;
}
