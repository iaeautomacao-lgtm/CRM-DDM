import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { pauseErrorResponse, readJson } from "@/lib/pausas/http";
import { parseReasonPatch } from "@/lib/pausas/pure";
import { patchReason } from "@/lib/pausas/service";

// PATCH /api/pausas/motivos/{id} { name?, max_minutes? (null = sem limite), active?, sort_order? } → { reason }   (presence.reasons_manage)
// Não há DELETE: desative (`active: false`). Editar não muda pausas já abertas nem o histórico (a pausa guarda cópia do nome e do limite).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission("presence.reasons_manage");
    const { id } = await params;
    const patch = parseReasonPatch(await readJson(request));
    return NextResponse.json({ reason: await patchReason(supabaseAdmin(), ctx.accountId, id, patch) });
  } catch (err) {
    return pauseErrorResponse(err);
  }
}
