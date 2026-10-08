import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { refreshAccountChannelHealth } from "@/lib/disparador/channel-health";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";

// POST /api/disparador/health/refresh — botão "Atualizar dados da Meta" (aba Números): mesma rotina do poll, só para os números Meta
// da conta, sem esperar o cron. Owner/admin; no máximo 1 por minuto por conta. Grava channel_health (nome, telefone, qualidade, tier) e
// corrige whatsapp_config.display_phone_number quando a Meta devolve outro valor.

export const maxDuration = 60;

export async function POST() {
  try {
    const { accountId } = await requireDisparadorAccess();
    const limit = checkRateLimit(`disparador-health-refresh:${accountId}`, { limit: 1, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const report = await refreshAccountChannelHealth(supabaseAdmin(), accountId);
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    return toErrorResponse(err);
  }
}
