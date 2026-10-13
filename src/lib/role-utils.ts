import type { AccountRole } from "@/lib/auth/roles";

// ============================================================
// Route-level RBAC gating.
//
// Layers on top of the existing capability predicates in
// lib/auth/roles.ts (canManageMembers, canEditSettings,
// canSendMessages) — it does not replace them. A route prefix with
// no entry here would be unrestricted (see canAccessRoute) — but
// every route the sidebar links to now has an explicit entry, so
// isRouteGated is true for every nav path and that fallback never
// actually applies today.
//
// Alcance por papel, proprietário à parte (ele sempre passa em
// canAccessRoute antes de a tabela ser consultada). Decisões do dono de 13/10/2026:
//   admin      → tudo de /settings, /equipes, /usuarios, /flows, /disparador,
//                /templates, /tabulacoes, /relatorios, /canais, /contacts,
//                /pipelines, /ajuda, /lead-extractor, /perfil, /historico
//   supervisor → /dashboard, /monitoramento, /inbox, /historico, /inteligencia,
//                /regua, /settings (as abas filtram: Agentes e Ferramentas só
//                leitura) e os relatórios de Atendimentos/Conversas/Tabulações/
//                Agentes (dados só das suas equipes — RLS da 140 e RPCs da 143)
//   agent      → /inbox, /historico, /automations, /respostas-rapidas
//   viewer     → /dashboard
//   todos      → /perfil (Perfil, Segurança e Aparência) e /seguranca
// /canais, /contacts, /pipelines, /ajuda e /lead-extractor: proprietário e admin
// (as APIs e o RLS dessas telas já aceitam o admin). /historico: quem atende
// conversas. Para cargo personalizado, "pages" em /api/me/permissions sai da
// permissão de cada tela (PAGE_MATRIX), não deste papel de compatibilidade.
// Rota nova de menu = uma entrada nova em ROUTE_ALLOWLIST (e em PAGE_MATRIX); sem
// entrada, isRouteGated deixa de cobri-la.
// ============================================================

/** Alias of AccountRole — kept separate so route-gating call sites
 *  don't need to know this reuses the account-sharing role enum. */
export type UserRole = AccountRole;

export const ROUTE_ALLOWLIST: Record<string, UserRole[]> = {
  "/dashboard": ["owner", "admin", "supervisor", "viewer"],
  "/monitoramento": ["owner", "admin", "supervisor"],
  // DDM Intelligence (PRD-04): supervisor vê só as suas equipes — o
  // escopo é aplicado nas ferramentas (lib/intelligence/scope.ts). Cobre
  // também /inteligencia/chaves (chaves pessoais do MCP de cada usuário).
  "/inteligencia": ["owner", "admin", "supervisor"],
  "/inbox": ["owner", "admin", "supervisor", "agent"],
  // Supervisor: só os relatórios de atendimento, já escopados às equipes
  // dele (migration 143). Precisa vir ANTES de "/relatorios" — a busca usa
  // o primeiro prefixo que casar. Envio em lote, Exportações e Auditoria
  // continuam só owner/admin.
  "/relatorios/atendimentos": ["owner", "admin", "supervisor"],
  "/relatorios/conversas": ["owner", "admin", "supervisor"],
  "/relatorios/tabulacoes": ["owner", "admin", "supervisor"],
  "/relatorios/agentes": ["owner", "admin", "supervisor"],
  "/relatorios": ["owner", "admin"],

  // Telas de gestão: proprietário e admin.
  "/canais": ["owner", "admin"],
  "/contacts": ["owner", "admin"],
  "/pipelines": ["owner", "admin"],
  "/lead-extractor": ["owner", "admin"],
  // Histórico de conversas encerradas: quem atende conversas (o RLS escopa o que cada um lê).
  "/historico": ["owner", "admin", "supervisor", "agent"],
  "/flows": ["owner", "admin"],
  // Decisão do dono (13/10, item 9): o visualizador NÃO vê /automations (o mesmo conjunto de automations.view).
  "/automations": ["owner", "admin", "supervisor", "agent"],
  "/disparador": ["owner", "admin"],
  // Régua de cobrança (PRD 17): ver = billing.view (supervisor+); editar = billing.manage (admin+, conferido na tela e nas rotas).
  "/regua": ["owner", "admin", "supervisor"],
  "/ajuda": ["owner", "admin"],

  "/settings": ["owner", "admin", "supervisor"],
  "/equipes": ["owner", "admin"],
  "/perfil": ["owner", "admin", "supervisor", "agent", "viewer"],
  "/seguranca": ["owner", "admin", "supervisor", "agent", "viewer"],
  "/templates": ["owner", "admin"],
  "/tabulacoes": ["owner", "admin"],
  // Cadastro das respostas rápidas (142); o uso no Inbox vale para todos.
  // 301: quem responde no Inbox abre a tela e cria as PESSOAIS; equipe e conta seguem com inbox.quick_replies.manage.
  "/respostas-rapidas": ["owner", "admin", "supervisor", "agent"],
  "/usuarios": ["owner", "admin"],
  // /membros itself now just redirects to /usuarios (kept for old
  // links/bookmarks) — still gated here too, defense in depth, even
  // though the redirect fires before this table is ever consulted.
  "/membros": ["owner", "admin"],
};

/** True if `pathname` matches a prefix this table restricts. Used to
 *  distinguish "not allowed" from "not gated at all" at call sites. */
export function isRouteGated(pathname: string): boolean {
  return Object.keys(ROUTE_ALLOWLIST).some((prefix) =>
    pathname.startsWith(prefix),
  );
}

/**
 * True if `role` may access `pathname`. Owner always passes. For any
 * other role, a pathname matching a ROUTE_ALLOWLIST prefix must have
 * that role listed there; a pathname matching no prefix is
 * unrestricted by this table.
 */
export function canAccessRoute(role: UserRole, pathname: string): boolean {
  if (role === "owner") return true;
  const entry = Object.entries(ROUTE_ALLOWLIST).find(([prefix]) =>
    pathname.startsWith(prefix),
  );
  if (!entry) return true;
  return entry[1].includes(role);
}

/** Landing route after login, or after a blocked-route redirect. */
export function getDefaultRoute(role: UserRole): string {
  if (role === "agent") return "/inbox";
  if (role === "supervisor") return "/monitoramento";
  return "/dashboard";
}
