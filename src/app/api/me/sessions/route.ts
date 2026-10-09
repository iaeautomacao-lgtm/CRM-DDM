// GET /api/me/sessions — dispositivos logados do PRÓPRIO usuário (PRD 24, item 7; migration 290).
// Qualquer membro autenticado. `current` marca o aparelho desta requisição. Nunca lista sessão de outro usuário.

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/account/admin-client";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { listSessions, sessionIdFromAccessToken } from "@/lib/auth/sessions";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { data } = await ctx.supabase.auth.getSession();
    const sessions = await listSessions(supabaseAdmin(), ctx.userId, sessionIdFromAccessToken(data.session?.access_token));
    return NextResponse.json({ sessions }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
