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
//   admin  → /dashboard, /monitoramento, /inbox, /relatorios, /settings, /equipes, /perfil
//   agent  → /inbox, /perfil
//   viewer → /dashboard, /perfil
// /perfil is the one route every role reaches — self-service profile +
// security (ProfileForm/SecurityPanel, the same components /settings
// already renders), carved out specifically so agent/viewer aren't
// stuck behind /settings' owner/admin gate just to change their own
// password.
// Routes no role above claims (/canais, /contacts, /pipelines,
// /flows, /disparador, /ajuda) are owner-only. Adding a new nav
// route = one new ROUTE_ALLOWLIST entry, or isRouteGated silently
// stops covering it.
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
  "/dashboard": ["owner", "admin", "viewer"],
  "/monitoramento": ["owner", "admin"],
  "/inbox": ["owner", "admin", "agent"],
  "/relatorios": ["owner", "admin"],

  // Owner-only — no other role's route list above claims these.
  "/canais": ["owner"],
  "/contacts": ["owner"],
  "/pipelines": ["owner"],
  "/flows": ["owner"],
  "/disparador": ["owner"],
  "/ajuda": ["owner"],

  "/settings": ["owner", "admin"],
  "/equipes": ["owner", "admin"],
  "/perfil": ["owner", "admin", "agent", "viewer"],
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
  return role === "agent" ? "/inbox" : "/dashboard";
}
