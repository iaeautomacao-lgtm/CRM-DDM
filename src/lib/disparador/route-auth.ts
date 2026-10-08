import { ForbiddenError, getCurrentAccount, type AccountContext } from "@/lib/auth/account";
import type { AccountRole } from "@/lib/auth/roles";
import { canAccessRoute } from "@/lib/role-utils";

// Quem pode criar, editar, desagendar, iniciar, pausar e encerrar campanhas:
// os mesmos papéis que enxergam a página /disparador/campanhas
// (ROUTE_ALLOWLIST em role-utils.ts — hoje owner e admin). Antes as rotas
// só exigiam sessão + conta: um viewer/agente chamando a API direto
// conseguia criar ou disparar campanha.

export const DISPARADOR_CAMPAIGNS_PATH = "/disparador/campanhas";

/** Papel pode gerenciar campanhas do disparador? (puro, testável) */
export function canManageCampaigns(role: AccountRole | null | undefined): boolean {
  return !!role && canAccessRoute(role, DISPARADOR_CAMPAIGNS_PATH);
}

/**
 * Sessão + conta + papel. Lança UnauthorizedError (401) sem sessão e
 * ForbiddenError (403) sem conta ou com papel insuficiente — use com
 * toErrorResponse.
 */
export async function requireDisparadorAccess(): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!canManageCampaigns(ctx.role)) {
    throw new ForbiddenError("Seu papel não permite gerenciar campanhas do disparador.");
  }
  return ctx;
}
