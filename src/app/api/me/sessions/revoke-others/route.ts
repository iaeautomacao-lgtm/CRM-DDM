// POST /api/me/sessions/revoke-others — "sair de todos os outros dispositivos" (mantém esta sessão). PRD 24, item 7.
// Sem identificar a sessão atual (token sem claim) NÃO encerra nada: evitaria derrubar o próprio usuário por engano.

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/account/admin-client";
import { logAuditEvent } from "@/lib/audit/log-event";
import { sessionRevokedEvent } from "@/lib/audit/security-events";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { revokeOtherSessions, sessionIdFromAccessToken } from "@/lib/auth/sessions";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST() {
  try {
    const ctx = await getCurrentAccount();
    const limit = await checkRateLimit(`admin:sessions:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const { data } = await ctx.supabase.auth.getSession();
    const current = sessionIdFromAccessToken(data.session?.access_token);
    if (!current) return NextResponse.json({ error: "Não foi possível identificar a sessão atual; entre de novo e tente outra vez" }, { status: 409, headers: NO_STORE });

    const count = await revokeOtherSessions(supabaseAdmin(), ctx.userId, current);
    if (count > 0) void logAuditEvent(sessionRevokedEvent({ accountId: ctx.accountId, userId: ctx.userId, sessionId: null, device: null, count }));
    return NextResponse.json({ revoked: count }, { headers: NO_STORE });
  } catch (err) {
    return toErrorResponse(err);
  }
}
