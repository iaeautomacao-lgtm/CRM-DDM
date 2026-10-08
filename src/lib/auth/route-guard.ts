import type { NextResponse } from "next/server";

import {
  requirePermission,
  requireRole,
  toErrorResponse,
  type AccountContext,
} from "@/lib/auth/account";
import type { Permission } from "@/lib/auth/permissions";
import type { AccountRole } from "@/lib/auth/roles";

// Guarda de papel para route handlers: sessão + conta + papel mínimo em uma
// chamada, devolvendo a resposta pronta (401/403) em vez de lançar. Use
// service role só DEPOIS de `ok` e sempre filtrando por `ctx.accountId`.
//
//   const auth = await guardRole("admin");
//   if (!auth.ok) return auth.response;
//   const { ctx } = auth;

export type GuardResult =
  | { ok: true; ctx: AccountContext }
  | { ok: false; response: NextResponse };

/** Igual a guardRole, mas por permissão do catálogo (PRD 20, fase 20.3). */
export async function guardPermission(permission: Permission): Promise<GuardResult> {
  try {
    return { ok: true, ctx: await requirePermission(permission) };
  } catch (err) {
    return { ok: false, response: toErrorResponse(err) };
  }
}

export async function guardRole(min: AccountRole): Promise<GuardResult> {
  try {
    return { ok: true, ctx: await requireRole(min) };
  } catch (err) {
    return { ok: false, response: toErrorResponse(err) };
  }
}
