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
//   admin  → /dashboard, /monitoramento, /inbox, /relatorios
//   agent  → /inbox only
//   viewer → /dashboard only
// Routes no role above claims (/canais, /contacts, /pipelines,
// /flows, /disparador, /settings, /ajuda) are owner-only. Adding a
// new nav route = one new ROUTE_ALLOWLIST entry, or isRouteGated
// silently stops covering it.
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
  "/settings": ["owner"],
  "/ajuda": ["owner"],
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
