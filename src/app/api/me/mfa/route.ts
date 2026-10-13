// GET /api/me/mfa — status do 2FA do PRÓPRIO usuário (PRD 24, item 7): { enabled, factors:[{id, type, name, status, created_at}] }.
// POST /api/me/mfa { event: 'enabled' | 'disabled', factor_id } — auditoria (revisão de segurança 13/10): o front avisa
// DEPOIS de ativar/remover; o servidor só registra se CONFIRMAR o estado real pelos fatores do usuário (RPC da 290):
// 'enabled' = o fator existe e está verificado; 'disabled' = o fator não existe mais. Sem confirmação: 409, nada gravado.
// Nunca devolve segredo/QR. Cadastro (enroll → challenge → verify) e remoção (unenroll) do TOTP NÃO passam pelo nosso servidor: o front usa
// supabase.auth.mfa.* com a sessão do próprio usuário. Requer MFA habilitado no projeto Supabase.

import { NextResponse } from "next/server";

import { supabaseAdmin } from "@/lib/account/admin-client";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { isUuid, listMfaFactors } from "@/lib/auth/sessions";
import { logAuditEvent } from "@/lib/audit/log-event";
import { mfaChangedEvent } from "@/lib/audit/security-events";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    return NextResponse.json(await listMfaFactors(supabaseAdmin(), ctx.userId), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const limit = await checkRateLimit(`admin:mfaAudit:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as { event?: unknown; factor_id?: unknown } | null;
    const event = body?.event;
    const factorId = body?.factor_id;
    if ((event !== "enabled" && event !== "disabled") || !isUuid(factorId)) {
      return NextResponse.json({ error: "Informe event ('enabled' ou 'disabled') e factor_id." }, { status: 400 });
    }

    const { factors } = await listMfaFactors(supabaseAdmin(), ctx.userId);
    const factor = factors.find((f) => f.id === factorId);
    const confirmed = event === "enabled" ? factor?.status === "verified" : !factor;
    if (!confirmed) {
      return NextResponse.json({ error: "O estado do 2FA não confere com o evento." }, { status: 409 });
    }
    await logAuditEvent(mfaChangedEvent({ accountId: ctx.accountId, userId: ctx.userId, factorId, enabled: event === "enabled" }));
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
