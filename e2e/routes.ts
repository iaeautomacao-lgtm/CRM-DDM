// Telas a cobrir e quem deve (ou não) vê-las. Nada é digitado à mão: as rotas saem do menu (nav.ts) e dos prefixos de
// ROUTE_ALLOWLIST; o acesso esperado vem de canAccessRoute (a mesma regra do servidor). Rota nova no menu ou na
// allowlist entra no teste sozinha.
import { bottomNavItems, navItems, navPath, reportNavItems } from "@/lib/nav";
import { ROUTE_ALLOWLIST, canAccessRoute, type UserRole } from "@/lib/role-utils";

// Telas de todos os papéis que não aparecem no menu nem na allowlist (menu do usuário).
const EXTRA_ROUTES = ["/perfil"];

export const ROUTES: readonly string[] = [
  ...new Set([
    ...[...navItems, ...reportNavItems, ...bottomNavItems].map((i) => navPath(i.href)),
    ...Object.keys(ROUTE_ALLOWLIST),
    ...EXTRA_ROUTES,
  ]),
].sort();

export function expectedAccess(role: UserRole, path: string): boolean {
  return canAccessRoute(role, path);
}

/** Itens do menu lateral que o papel NÃO deve ver / DEVE ver (sem os que dependem de permissão fina ou de aba). */
export function navExpectations(role: UserRole) {
  const items = navItems.filter((i) => !i.permission && !i.href.includes("?"));
  return {
    hidden: items.filter((i) => !canAccessRoute(role, navPath(i.href))).map((i) => navPath(i.href)),
    visible: items.filter((i) => canAccessRoute(role, navPath(i.href))).map((i) => navPath(i.href)),
  };
}
