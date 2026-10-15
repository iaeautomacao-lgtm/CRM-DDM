import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { pauseErrorResponse } from "@/lib/pausas/http";
import { currentPause } from "@/lib/pausas/service";

// GET /api/pausas/atual → { pause: <pause> | null }: a pausa aberta de quem está logado (com motivo, início, limite e tempo decorrido).
export async function GET() {
  try {
    const ctx = await requirePermission("presence.pause_self");
    return NextResponse.json({ pause: await currentPause(supabaseAdmin(), ctx.accountId, ctx.userId) });
  } catch (err) {
    return pauseErrorResponse(err);
  }
}
