import { recordAccessDenied } from "@/lib/audit/access-denied";
import { ForbiddenError, getCurrentAccount, type AccountContext } from "@/lib/auth/account";
import { can } from "@/lib/auth/permissions";
import type { AccountRole } from "@/lib/auth/roles";

// Quem pode criar, editar, desagendar, iniciar, pausar e encerrar campanhas:
// a permissão `campaigns.manage` (PRD 20, 20.3c — hoje owner e admin, os mesmos papéis que enxergam
// a página /disparador/campanhas). Antes as rotas
// só exigiam sessão + conta: um viewer/agente chamando a API direto
// conseguia criar ou disparar campanha.

/** Papel de sistema pode gerenciar campanhas do disparador? (puro, testável; == can(papel, "campaigns.manage")) */
export function canManageCampaigns(role: AccountRole | null | undefined): boolean {
  return !!role && can({ role }, "campaigns.manage");
}

/** Permissões do disparador que as rotas podem exigir. */
export type DisparadorPermission = "campaigns.manage" | "campaigns.rate_limit";

/**
 * Sessão + conta + permissão (padrão `campaigns.manage`; limites por segundo usam `campaigns.rate_limit`).
 * Lança UnauthorizedError (401) sem sessão e ForbiddenError (403) sem conta ou sem a permissão — use com
 * toErrorResponse (o 403 traz `code: 'forbidden'` e a `permission` que faltou).
 */
export async function requireDisparadorAccess(
  permission: DisparadorPermission = "campaigns.manage",
): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!can(ctx, permission)) {
    recordAccessDenied(ctx, permission); // 20.8 (amostrado; fire-and-forget)
    throw new ForbiddenError("Seu papel não permite gerenciar campanhas do disparador.", permission);
  }
  return ctx;
}
