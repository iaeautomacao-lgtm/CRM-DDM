import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { getMonitorSnapshot } from "@/lib/disparador/monitor-snapshot";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

// GET /api/disparador/monitor/snapshot — Monitor ao vivo (P1-8).
//
// UM endpoint: números (envios/min, em voo, fila, ETA, freio), campanhas em execução (progresso, ritmo,
// ETA real, erros, 131026 pendentes, pausa automática), erros recentes agrupados por código com o texto do
// catálogo, feed de eventos e alertas. Escopado pela conta da sessão (owner/admin), com cache de ~2,5 s
// por conta para que várias abas em polling de 3 s custem uma leitura só. Nada varre a fila inteira.
export async function GET() {
  try {
    const { accountId } = await requireDisparadorAccess();
    const snapshot = await getMonitorSnapshot(supabaseAdmin(), accountId);
    return NextResponse.json({ ok: true, snapshot }, { headers: NO_STORE });
  } catch (err) {
    const response = toErrorResponse(err);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  }
}
