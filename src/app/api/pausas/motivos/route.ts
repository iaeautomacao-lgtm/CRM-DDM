import { NextResponse } from "next/server";

import { can } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { pauseErrorResponse, readJson } from "@/lib/pausas/http";
import { parseReasonCreate } from "@/lib/pausas/pure";
import { createReason, listReasons } from "@/lib/pausas/service";

// GET  /api/pausas/motivos[?todos=1]  → { reasons: [{ id, name, max_minutes, active, sort_order }] }
// POST /api/pausas/motivos { name, max_minutes? } → 201 { reason }     (presence.reasons_manage)
// Contrato: prd-v2/pausas-contrato-api.md. Na primeira leitura de uma conta sem motivos o servidor cria os 4 padrões (Almoço 60, Banheiro 10,
// Treinamento 120, Outro sem limite). Os inativos só aparecem para quem gerencia os motivos (?todos=1).
export async function GET(request: Request) {
  try {
    const ctx = await requirePermission("presence.pause_self");
    const all = new URL(request.url).searchParams.get("todos") === "1" && can(ctx, "presence.reasons_manage");
    return NextResponse.json({ reasons: await listReasons(supabaseAdmin(), ctx.accountId, all) });
  } catch (err) {
    return pauseErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requirePermission("presence.reasons_manage");
    const input = parseReasonCreate(await readJson(request));
    return NextResponse.json({ reason: await createReason(supabaseAdmin(), ctx.accountId, input) }, { status: 201 });
  } catch (err) {
    return pauseErrorResponse(err);
  }
}
