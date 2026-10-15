import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { pauseErrorResponse } from "@/lib/pausas/http";
import { PauseApiError, isUuid } from "@/lib/pausas/pure";
import { teamPauses } from "@/lib/pausas/service";

// GET /api/pausas/equipe[?team_id=uuid] → { pauses: [<pause> + team_ids] }: as pausas ABERTAS do escopo de quem chama (monitoring.view_all =
// a conta toda; monitoring.view_team = as equipes dele — a RLS de agent_pauses decide). Para o selo "Pausa: Almoço 23 min" no Monitoramento.
export async function GET(request: Request) {
  try {
    const ctx = await requirePermission("monitoring.view_team");
    const team = new URL(request.url).searchParams.get("team_id");
    if (team && !isUuid(team)) throw new PauseApiError("invalid_request", "`team_id` inválido", 400);
    return NextResponse.json({ pauses: await teamPauses(ctx.supabase, supabaseAdmin(), ctx.accountId, team) });
  } catch (err) {
    return pauseErrorResponse(err);
  }
}
