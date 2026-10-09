// DELETE /api/me/sessions/{id} — encerra UM dispositivo do próprio usuário (PRD 24, item 7). O refresh token dele deixa de valer na hora;
// o access token atual expira em até ~1 h (limite do JWT). Encerrar a sessão ATUAL equivale a sair. 404 se não existir ou não for dele.

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/account/admin-client";
import { logAuditEvent } from "@/lib/audit/log-event";
import { sessionRevokedEvent } from "@/lib/audit/security-events";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { isUuid, listSessions, revokeSession, sessionIdFromAccessToken } from "@/lib/auth/sessions";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Sessão não encontrada" }, { status: 404, headers: NO_STORE });

    const limit = await checkRateLimit(`admin:sessions:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const db = supabaseAdmin();
    const { data } = await ctx.supabase.auth.getSession();
    const sessions = await listSessions(db, ctx.userId, sessionIdFromAccessToken(data.session?.access_token));
    const target = sessions.find((s) => s.id === id);
    if (!target || !(await revokeSession(db, ctx.userId, id))) {
      return NextResponse.json({ error: "Sessão não encontrada" }, { status: 404, headers: NO_STORE });
    }
    void logAuditEvent(sessionRevokedEvent({ accountId: ctx.accountId, userId: ctx.userId, sessionId: id, device: target.device, count: 1 }));
    return NextResponse.json({ id, revoked: true, was_current: target.current }, { headers: NO_STORE });
  } catch (err) {
    return toErrorResponse(err);
  }
}
