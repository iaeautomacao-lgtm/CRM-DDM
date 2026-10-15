import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { pauseErrorResponse, readJson } from "@/lib/pausas/http";
import { PauseApiError, isUuid } from "@/lib/pausas/pure";
import { endPause } from "@/lib/pausas/service";

// POST /api/pausas/retomar { user_id? } → 200 { pause } (já com ended_at e end_kind)
// Sem user_id = voltar ao atendimento. Quem foi pausado por outra pessoa não se retoma sozinho (403 paused_by_supervisor): só quem tem
// presence.pause_others no escopo dele. Erros: not_paused, forbidden, other_team, user_not_found, paused_by_supervisor.
export async function POST(request: Request) {
  try {
    const ctx = await requirePermission("presence.pause_self");
    const body = ((await readJson(request)) ?? {}) as { user_id?: unknown };
    if (typeof body !== "object" || (body.user_id !== undefined && body.user_id !== null && !isUuid(body.user_id))) {
      throw new PauseApiError("invalid_request", "`user_id` inválido", 400);
    }
    const target = typeof body.user_id === "string" && body.user_id !== ctx.userId ? body.user_id : null;
    return NextResponse.json({ pause: await endPause(ctx.supabase, supabaseAdmin(), ctx.accountId, target) });
  } catch (err) {
    return pauseErrorResponse(err);
  }
}
