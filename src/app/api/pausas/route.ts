import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { pauseErrorResponse, readJson } from "@/lib/pausas/http";
import { PauseApiError, isUuid } from "@/lib/pausas/pure";
import { startPause } from "@/lib/pausas/service";

// POST /api/pausas { reason_id, user_id? } → 201 { pause }
// Sem user_id = pausar a si mesmo (presence.pause_self). Com user_id de outra pessoa o BANCO exige presence.pause_others e escopo (supervisor:
// só quem divide equipe com ele; quem tem monitoring.view_all: qualquer um da conta) — start_pause, migration 370. Uma pausa aberta por
// atendente (409 already_paused). Erros: invalid_request, forbidden, other_team, user_not_found, reason_not_found, reason_inactive, already_paused.
export async function POST(request: Request) {
  try {
    const ctx = await requirePermission("presence.pause_self");
    const body = (await readJson(request)) as { reason_id?: unknown; user_id?: unknown } | null;
    if (!body || typeof body !== "object" || !isUuid(body.reason_id)) throw new PauseApiError("invalid_request", "Informe `reason_id` (id do motivo)", 400);
    if (body.user_id !== undefined && body.user_id !== null && !isUuid(body.user_id)) throw new PauseApiError("invalid_request", "`user_id` inválido", 400);
    const target = typeof body.user_id === "string" && body.user_id !== ctx.userId ? body.user_id : null;
    const pause = await startPause(ctx.supabase, supabaseAdmin(), ctx.accountId, { reasonId: body.reason_id, targetUserId: target });
    return NextResponse.json({ pause }, { status: 201 });
  } catch (err) {
    return pauseErrorResponse(err);
  }
}
