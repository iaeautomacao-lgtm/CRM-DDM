import type { NextResponse } from "next/server";

import {
  requireRole,
  toErrorResponse,
  type AccountContext,
} from "@/lib/auth/account";
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

export async function guardRole(min: AccountRole): Promise<GuardResult> {
  try {
    return { ok: true, ctx: await requireRole(min) };
  } catch (err) {
    return { ok: false, response: toErrorResponse(err) };
  }
}
