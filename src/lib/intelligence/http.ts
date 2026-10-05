// Ponte entre as rotas /api/intelligence/* e o core: contexto
// autenticado → escopo, e erro → resposta HTTP.

import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { BadRequestError, NotFoundError } from "./errors";
import { resolveIntelligenceScope, type IntelligenceScope } from "./scope";

/** Escopo do usuário logado (owner/admin/supervisor; demais → 403). */
export async function currentIntelligenceScope(): Promise<IntelligenceScope> {
  const ctx = await getCurrentAccount();
  return resolveIntelligenceScope(
    { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role },
    supabaseAdmin(),
  );
}

export function intelligenceErrorResponse(err: unknown): NextResponse {
  if (err instanceof BadRequestError || err instanceof NotFoundError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  return toErrorResponse(err);
}
