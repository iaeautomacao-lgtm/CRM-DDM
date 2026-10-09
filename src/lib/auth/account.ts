// ============================================================
// Server-side account context — for API routes and server
// components. Reads the caller's profile + account in one round
// trip and verifies role on demand.
//
// IMPORTANT: this module is server-only. It imports the Supabase
// SSR client (`@/lib/supabase/server`), which reads `next/headers`
// cookies. Importing it from a client component will fail at
// build time with the standard Next.js "You're importing a
// component that needs `next/headers`" error — that's the
// boundary check; we don't need the `server-only` package.
//
// Calling convention
// ------------------
// API routes don't need to redo `supabase.auth.getUser()` — they
// receive a fully-loaded context from `requireRole`:
//
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.supabase — the SSR client (RLS scoped to this user)
//     // ctx.userId  — auth.uid()
//     // ctx.accountId / ctx.role / ctx.account
//   } catch (err) {
//     return errorResponse(err); // see toErrorResponse() below
//   }
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { recordAccessDenied } from "@/lib/audit/access-denied";
import { can, permissionsForRole, type Permission } from "./permissions";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";
import { MFA_REQUIRED_CODE } from "./mfa";

// ------------------------------------------------------------
// Errors
//
// Custom classes so API routes can map a single `catch` to the
// right HTTP status without sprinkling 401/403 strings everywhere.
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Não autorizado") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Membro desativado (TASK3, migration 311): 403 com code 'member_deactivated' — vale enquanto o token antigo ainda vive. */
export class MemberDeactivatedError extends Error {
  readonly status = 403 as const;
  readonly code = "member_deactivated" as const;
  constructor(message = "Seu acesso a esta organização foi desativado. Fale com o administrador.") {
    super(message);
    this.name = "MemberDeactivatedError";
  }
}

/** Sessão só com senha de quem tem 2FA (src/lib/auth/mfa.ts): 401 com code 'mfa_required'. */
export class MfaRequiredError extends Error {
  readonly status = 401 as const;
  readonly code = MFA_REQUIRED_CODE;
  constructor(message = "Confirme o código de verificação em duas etapas.") {
    super(message);
    this.name = "MfaRequiredError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  /** Permissão que faltou (PRD 20): o front pode mostrar "sem permissão para …". */
  readonly permission?: Permission;
  constructor(message = "Acesso negado", permission?: Permission) {
    super(message);
    this.name = "ForbiddenError";
    this.permission = permission;
  }
}

/**
 * Convert one of the typed errors above (or anything else) into a
 * `NextResponse`. Routes can do:
 *
 *   } catch (err) {
 *     return toErrorResponse(err);
 *   }
 *
 * Unknown errors collapse to 500 with the generic message — we
 * never leak `err.message` for non-classified errors to keep
 * server internals out of the wire.
 */
export function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof MemberDeactivatedError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof MfaRequiredError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  if (err instanceof ForbiddenError && err.permission) {
    // Campos extras são aditivos: quem lê só `error` (string) continua funcionando.
    return NextResponse.json(
      { error: err.message, code: "forbidden", permission: err.permission },
      { status: err.status },
    );
  }
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Erro interno do servidor" }, { status: 500 });
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** Supabase SSR client, RLS scoped to the calling user. */
  supabase: SupabaseClient;
  /** `auth.uid()` for the caller. Always defined when this resolves. */
  userId: string;
  /** Caller's account_id from their profile row. */
  accountId: string;
  /** Caller's role within their account. */
  role: AccountRole;
  /**
   * Permissões efetivas do chamador (PRD 20, fase 20.2). COMPAT: derivadas do papel de sistema
   * (permissionsForRole) — o papel personalizado ainda não existe, então é exatamente o conjunto que
   * as checagens por papel já decidem. Nenhuma rota usa isto para decidir ainda (fase 20.3).
   * Quando o personalizado existir, vem de profiles.role_id ⨝ role_permissions (migration 240).
   */
  permissions: ReadonlySet<Permission>;
  /** Lightweight account meta — id + name. */
  account: { id: string; name: string };
}

/**
 * Resolve the caller's user + account + role in one round trip.
 *
 * Throws `UnauthorizedError` if there's no Supabase session.
 * Throws `ForbiddenError` if the profile is missing account
 * fields (shouldn't happen post-017 migration; defensive guard
 * against profile rows that pre-date the backfill or were
 * inserted by hand).
 *
 * Use `requireRole(min)` instead when the route also needs a
 * minimum-role check — it's a thin wrapper over this.
 */
export async function getCurrentAccount(): Promise<AccountContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if ((userErr as { code?: string } | null)?.code === MFA_REQUIRED_CODE) {
    throw new MfaRequiredError();
  }
  if (userErr || !user) {
    throw new UnauthorizedError();
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[getCurrentAccount] profile fetch error:", error);
    throw new ForbiddenError("Não foi possível carregar o contexto da conta");
  }
  if (!data || !data.account_id || !data.account_role) {
    // Pre-migration profile, or a manual insert that skipped the
    // signup trigger. The user is authenticated but the app has
    // no way to scope their queries — treat as forbidden.
    throw new ForbiddenError("O perfil não está vinculado a uma conta");
  }
  if ((data as { deactivated_at?: string | null }).deactivated_at) {
    throw new MemberDeactivatedError();
  }
  if (!isAccountRole(data.account_role)) {
    // The DB enum should make this impossible, but a future
    // migration that broadens the enum without updating TS would
    // hit this — surface it rather than silently widening.
    throw new ForbiddenError(`Papel de conta desconhecido: ${data.account_role}`);
  }

  // Load the account with a plain point lookup by id rather than an
  // embedded FK join (`account:accounts!inner(...)`). The embed forces
  // PostgREST to resolve the profiles.account_id → accounts.id
  // relationship from its schema cache; when that cache is stale — a
  // common Supabase state right after a migration adds the FK, or when
  // migrations are applied out of band — the embed fails hard with
  // PGRST200 ("could not find a relationship … in the schema cache")
  // and takes down the entire account context (issue #294). A lookup by
  // id needs no relationship inference and is gated by the same accounts
  // RLS, so it stays robust against cache staleness and older schemas.
  const { data: account, error: accountErr } = await supabase
    .from("accounts")
    .select("id, name")
    .eq("id", data.account_id)
    .maybeSingle();

  if (accountErr) {
    console.error("[getCurrentAccount] account fetch error:", accountErr);
    throw new ForbiddenError("Não foi possível carregar o contexto da conta");
  }
  if (!account) {
    // account_id points at no readable account row — orphaned profile
    // or an RLS gap. Same "can't scope this user" outcome as above.
    throw new ForbiddenError("O perfil não está vinculado a uma conta");
  }

  return {
    supabase,
    userId: user.id,
    accountId: data.account_id,
    role: data.account_role,
    permissions: permissionsForRole(data.account_role),
    account: { id: account.id, name: account.name },
  };
}

/**
 * Resolve o contexto da conta e exige uma PERMISSÃO do catálogo (PRD 20, fase 20.3).
 * Substitui `requireRole(min)` rota a rota, com o mesmo resultado para os 5 papéis de
 * sistema (matriz dourada: src/lib/auth/permissions-matrix.ts). Fail-closed: chave fora
 * do catálogo nega. 401 sem sessão; 403 `{error, code:'forbidden', permission}`.
 */
export async function requirePermission(permission: Permission): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!can(ctx, permission)) {
    // 20.8: o 403 vira evento `access.denied` (amostrado; fire-and-forget — não muda a resposta)
    recordAccessDenied(ctx, permission);
    throw new ForbiddenError(`Esta ação exige a permissão '${permission}'`, permission);
  }
  return ctx;
}

/**
 * Resolve the caller's account context and enforce a minimum role.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError("Insufficient role")`
 * when the caller is below `min`.
 */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `Esta ação exige o papel '${min}' ou superior`,
    );
  }
  return ctx;
}
