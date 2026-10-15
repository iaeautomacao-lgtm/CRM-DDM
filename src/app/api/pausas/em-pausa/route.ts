import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { pauseErrorResponse } from "@/lib/pausas/http";
import { inPauseUserIds } from "@/lib/pausas/service";

// GET /api/pausas/em-pausa → { user_ids: [uuid] }: só os ids de quem está em pausa agora na conta (sem motivo nem tempo), para marcar
// "em pausa" nas listas de atribuição/transferência. Quem pode transferir conversa (inbox.transfer).
export async function GET() {
  try {
    const ctx = await requirePermission("inbox.transfer");
    return NextResponse.json({ user_ids: await inPauseUserIds(supabaseAdmin(), ctx.accountId) });
  } catch (err) {
    return pauseErrorResponse(err);
  }
}
