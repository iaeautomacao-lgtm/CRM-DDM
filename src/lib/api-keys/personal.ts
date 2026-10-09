// ============================================================
// Chaves de API pessoais (PRD-04 Fase 3, MCP do DDM Intelligence) —
// regras puras, sem I/O.
//
// Uma chave com `intelligence:read` é PESSOAL: fica ligada ao usuário que
// a criou (api_keys.user_id, migration 154) e age como ele — o escopo de
// dados é recalculado a cada requisição a partir do papel e das equipes
// atuais desse usuário (src/lib/intelligence/api-key.ts). Por isso:
//   - é sempre do próprio criador (ninguém cria chave pessoal para outro);
//   - é exclusiva: não mistura com escopos da conta (messages:send…), que
//     continuariam valendo mesmo se o dono perdesse o acesso;
//   - owner/admin criam qualquer chave; supervisor só a pessoal dele;
//     agente e viewer não criam chave.
// ============================================================

import { normalizeScopes, type ApiScope } from './scopes';

/** Escopos que exigem dono (user_id). */
export const PERSONAL_SCOPES: readonly ApiScope[] = ['intelligence:read'];

export function isPersonalScope(scope: string): boolean {
  return (PERSONAL_SCOPES as readonly string[]).includes(scope);
}

/** True se o conjunto de escopos faz da chave uma chave pessoal. */
export function isPersonalKeyScopes(scopes: readonly string[]): boolean {
  return scopes.some(isPersonalScope);
}

export type KeyCreationPlan =
  | { ok: true; scopes: ApiScope[]; userId: string | null; personal: boolean }
  | { ok: false; status: 400 | 403; error: string };

/** O que o criador pode (PRD 20): gerir as chaves da conta e/ou criar a própria chave pessoal. */
export interface KeyCreatorCaps {
  /** `api_keys.manage` (owner/admin hoje). */
  canManage: boolean;
  /** `intelligence.personal_key` (supervisor+ hoje). */
  canPersonal: boolean;
}

/**
 * Decide se o criador (`caps`) pode criar uma chave com `rawScopes` e, se puder, com
 * qual dono. O dono da chave pessoal é sempre o próprio criador.
 */
export function planKeyCreation(
  caps: KeyCreatorCaps,
  creatorId: string,
  rawScopes: unknown
): KeyCreationPlan {
  const scopes = normalizeScopes(rawScopes ?? []);
  if (scopes === null) {
    return {
      ok: false,
      status: 400,
      error: "'scopes' must be an array of known scope strings",
    };
  }

  const personal = isPersonalKeyScopes(scopes);
  if (personal && scopes.length !== 1) {
    return {
      ok: false,
      status: 400,
      error:
        'A chave de Inteligência é pessoal e não pode ser combinada com outros escopos',
    };
  }

  if (caps.canManage) {
    return { ok: true, scopes, userId: personal ? creatorId : null, personal };
  }
  if (caps.canPersonal) {
    if (!personal) {
      return {
        ok: false,
        status: 403,
        error: 'Supervisor só pode criar a própria chave de Inteligência (leitura)',
      };
    }
    return { ok: true, scopes, userId: creatorId, personal };
  }
  return { ok: false, status: 403, error: 'Papel insuficiente para esta ação' };
}
