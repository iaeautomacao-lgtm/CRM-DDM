import { NextResponse } from "next/server";

import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { buildSystemHealth } from "@/lib/ops/system-health";

// GET /api/ops/status — "Saúde do sistema" (cartão em Logs; PRD 24, item 5). Owner/admin (audit.view).
// Estado da plataforma (migrations aplicadas, último tick do cron, fila de mensagens recebidas) — dado de INFRAESTRUTURA, igual para toda
// conta, sem dado de cliente. Lê com service role depois de checar a permissão da sessão. Cada bloco degrada sozinho.
export async function GET() {
  try {
    await requirePermission("audit.view");
    const health = await buildSystemHealth(supabaseAdmin());
    return NextResponse.json({ data: health }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
