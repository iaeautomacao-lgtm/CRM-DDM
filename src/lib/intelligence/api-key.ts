// Autenticação do Intelligence por chave de API PESSOAL (MCP, PRD-04
// Fase 3). Contrapartida de http.ts#currentIntelligenceScope para quem não
// tem sessão: `Authorization: Bearer wacrm_live_…` com o escopo
// `intelligence:read`.
//
// O escopo de dados NUNCA vem da chave em si: a cada requisição relemos o
// perfil do dono (api_keys.user_id) e recalculamos o escopo exatamente como
// na sessão (resolveIntelligenceScope). Assim, rebaixar o usuário, tirá-lo
// de uma equipe ou removê-lo da conta reduz/bloqueia o acesso na hora;
// revogar a chave também (findActiveKeyByHash ignora chaves revogadas).

import type { SupabaseClient } from "@supabase/supabase-js";
import { forbidden, type ApiError } from "@/lib/api/v1/respond";
import { ForbiddenError } from "@/lib/auth/account";
import { requireApiKey, type ApiKeyContext } from "@/lib/auth/api-context";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { resolveIntelligenceScope, type IntelligenceScope } from "./scope";

export interface IntelligenceKeyContext {
  scope: IntelligenceScope;
  keyId: string;
}

export interface IntelligenceKeyDeps {
  /** Padrão: requireApiKey (hash → chave ativa, limite por chave, escopo). */
  authenticate?: (request: Request) => Promise<ApiKeyContext>;
  /** Cliente service role para perfil/equipes (padrão: supabaseAdmin()). */
  db?: SupabaseClient;
}

/**
 * Autentica a requisição e devolve o escopo do dono da chave. Lança
 * ApiError (401 sem chave/revogada/expirada; 403 sem intelligence:read,
 * sem dono, dono fora da conta ou papel sem acesso; 429 limite da chave).
 */
export async function requireIntelligenceApiKey(
  request: Request,
  deps: IntelligenceKeyDeps = {},
): Promise<IntelligenceKeyContext> {
  const authenticate = deps.authenticate ?? ((req: Request) => requireApiKey(req, "intelligence:read"));
  const key = await authenticate(request);
  const errCtx = { accountId: key.accountId, keyId: key.keyId };
  const deny = (message: string): ApiError => forbidden(message, errCtx);

  // Defesa em profundidade: o requireApiKey padrão já exige o escopo.
  if (!key.scopes.includes("intelligence:read")) {
    throw deny("Esta chave não tem o escopo intelligence:read");
  }
  if (!key.userId) {
    throw deny("Chave sem dono: o acesso ao Intelligence exige uma chave pessoal");
  }

  const db = deps.db ?? supabaseAdmin();
  const { data, error } = await db
    .from("profiles")
    .select("account_id, account_role")
    .eq("user_id", key.userId)
    .limit(1);
  if (error) throw new Error(`Falha ao carregar o perfil do dono da chave: ${error.message}`);
  const profile = (data ?? [])[0] as { account_id: string | null; account_role: string | null } | undefined;
  if (!profile || profile.account_id !== key.accountId || !profile.account_role) {
    throw deny("O dono desta chave não faz mais parte da conta");
  }

  try {
    const scope = await resolveIntelligenceScope(
      { accountId: key.accountId, userId: key.userId, role: profile.account_role },
      db,
    );
    return { scope, keyId: key.keyId };
  } catch (err) {
    if (err instanceof ForbiddenError) throw deny(err.message);
    throw err;
  }
}
