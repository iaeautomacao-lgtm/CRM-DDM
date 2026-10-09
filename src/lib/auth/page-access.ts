// Acesso a páginas a partir de GET /api/me/permissions (campo `pages`).
//
// O servidor monta `pages` com os prefixos de ROUTE_ALLOWLIST que o papel
// acessa. Para saber qual prefixo governa uma rota, o front usa a MESMA
// regra do servidor (canAccessRoute): o primeiro prefixo de ROUTE_ALLOWLIST,
// na ordem declarada, com que o caminho começa. Rota sem prefixo = livre.
// Assim o front não duplica a tabela de quem acessa o quê.

import { ROUTE_ALLOWLIST } from "@/lib/role-utils";

/** Prefixo de gate que governa o caminho, ou null se a rota é livre. */
export function pageGate(pathname: string): string | null {
  return Object.keys(ROUTE_ALLOWLIST).find((prefix) => pathname.startsWith(prefix)) ?? null;
}

/** O usuário (pelas `pages` do servidor) pode abrir este caminho? */
export function canOpenPage(pages: readonly string[], pathname: string): boolean {
  const gate = pageGate(pathname);
  return gate === null || pages.includes(gate);
}
