import type { AccountRole } from "@/lib/auth/roles";

// ============================================================
// Route-level RBAC gating.
//
// Layers on top of the existing capability predicates in
// lib/auth/roles.ts (canManageMembers, canEditSettings,
// canSendMessages) — it does not replace them. Only the route
// prefixes listed in ROUTE_ALLOWLIST are gated here; a route
// prefix with no entry is unrestricted by this table.
//
// `admin` is intentionally locked to exactly /dashboard,
// /monitoramento and /inbox — every other nav-exposed route below
// lists every role EXCEPT admin so that lockout is strict rather
// than "admin happens to be omitted." Adding a new gated route =
// one new ROUTE_ALLOWLIST entry.
// ============================================================

/** Alias of AccountRole — kept separate so route-gating call sites
 *  don't need to know this reuses the account-sharing role enum. */
export type UserRole = AccountRole;

export const ROUTE_ALLOWLIST: Record<string, UserRole[]> = {
  "/dashboard": ["owner", "admin", "agent", "viewer"],
  "/monitoramento": ["owner", "admin"],
  "/inbox": ["owner", "admin", "agent"],

  // admin excluded from everything below — strictly locked to the
  // three routes above.
  "/canais": ["owner", "agent", "viewer"],
  "/contacts": ["owner", "agent", "viewer"],
  "/pipelines": ["owner", "agent", "viewer"],
  "/flows": ["owner", "agent", "viewer"],
  "/disparador": ["owner", "agent", "viewer"],
  "/settings": ["owner", "agent", "viewer"],
  "/relatorios": ["owner", "agent", "viewer"],
  "/ajuda": ["owner", "agent", "viewer"],
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
