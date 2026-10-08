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
// Per-role reach, owner aside (owner always passes in canAccessRoute
// before this table is even consulted):
//   admin  → /dashboard, /monitoramento, /inbox, /relatorios, /settings,
//            /equipes, /perfil, /templates, /tabulacoes, /usuarios,
//            /flows, /disparador
//   (owner/admin/supervisor também → /inteligencia, o DDM Intelligence)
//   supervisor → /dashboard, /monitoramento, /inbox e os relatórios de
//            Atendimentos/Conversas/Agentes (dados só das suas equipes —
//            RLS da migration 140 e RPCs escopadas na 143)
//   agent  → /inbox
//   viewer → /dashboard
// /templates, /tabulacoes, /usuarios are TemplateManager/
// FieldsAndTagsPanel/MembersTab moved out of /settings onto their own
// routes (settings-sections.ts no longer registers those sections) —
// owner/admin only, same reach as /settings itself already had.
// /perfil (ProfileForm/SecurityPanel, same components /settings
// renders) is owner/admin only — agents get an inline "Trocar senha"
// dialog straight from the sidebar footer instead (no route needed);
// viewer currently has no self-service password change path at all
// as a result of this narrowing (flagged, not something this change
// added a replacement for).
// /flows and /disparador opened to admin (decisão de 02/10/2026): o
// admin abre o fluxo e a campanha a partir do inbox (card "Fluxo" e
// faixa "Campanha"). As APIs dessas páginas já são escopadas por conta
// via RLS, então nenhuma rota de API precisou mudar.
// Routes no role above claims (/canais, /contacts, /pipelines,
// /ajuda) are owner-only. Adding a new nav
// route = one new ROUTE_ALLOWLIST entry, or isRouteGated silently
// stops covering it.
//
// /pipelines was pulled from the sidebar's navItems only — it stays in
// ROUTE_ALLOWLIST as owner-only, so a direct URL visit still redirects
// non-owners same as before; this is purely a nav-visibility change,
// not a permission change.
//
// /settings was owner-only until admin was added here to match
// several settings panels' own internal gating (TeamsPanel,
// api-keys-settings, members-tab all already wrap their write
// actions in <RequireRole min="admin">) — those checks were
// unreachable dead code for admins as long as the page itself
// redirected them to /unauthorized before ever rendering.
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

  // Owner-only — no other role's route list above claims these.
  "/canais": ["owner"],
  "/contacts": ["owner"],
  "/pipelines": ["owner"],
  "/flows": ["owner", "admin"],
  "/disparador": ["owner", "admin"],
  "/ajuda": ["owner"],

  "/settings": ["owner", "admin"],
  "/equipes": ["owner", "admin"],
  "/perfil": ["owner", "admin"],
  "/seguranca": ["owner", "admin", "supervisor", "agent", "viewer"],
  "/templates": ["owner", "admin"],
  "/tabulacoes": ["owner", "admin"],
  // Cadastro das respostas rápidas (142); o uso no Inbox vale para todos.
  "/respostas-rapidas": ["owner", "admin"],
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
