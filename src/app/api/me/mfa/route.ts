// GET /api/me/mfa — status do 2FA do PRÓPRIO usuário (PRD 24, item 7): { enabled, factors:[{id, type, name, status, created_at}] }.
// Nunca devolve segredo/QR. Cadastro (enroll → challenge → verify) e remoção (unenroll) do TOTP NÃO passam pelo nosso servidor: o front usa
// supabase.auth.mfa.* com a sessão do próprio usuário. Requer MFA habilitado no projeto Supabase.

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/account/admin-client";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { listMfaFactors } from "@/lib/auth/sessions";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json(await listMfaFactors(supabaseAdmin(), ctx.userId), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
