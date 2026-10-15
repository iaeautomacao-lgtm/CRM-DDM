import { NextResponse } from "next/server";

import { registerAuditActor } from "@/lib/audit/context";
import { matchesOperationalSecret } from "@/lib/auth/operational-secret";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { runPauseCron } from "@/lib/pausas/alerts";

// POST /api/pausas/cron — a cada minuto, com o mesmo segredo dos demais crons:
//   curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" https://<host>/api/pausas/cron
// Stateless: (1) fecha a pausa de quem ficou desconectado por mais de 15 minutos (end_kind = desconexao); (2) marca e avisa o supervisor das
// pausas que passaram do tempo máximo (uma vez por pausa). Sem a migration 371 devolve 503 (nada quebra; a distribuição segue filtrando pausados).
export const maxDuration = 60;

export async function POST(request: Request) {
  await registerAuditActor({ actorType: "system", source: "cron_pausas" });
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!matchesOperationalSecret(process.env.CRON_SECRET, request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const startedAt = Date.now();
    const summary = await runPauseCron(supabaseAdmin());
    return NextResponse.json({ status: summary.closedByDisconnect || summary.exceeded ? "processed" : "idle", ...summary, duration_ms: Date.now() - startedAt });
  } catch (error) {
    console.error("[PausasCron] Falha operacional:", error instanceof Error ? error.message : "erro");
    return NextResponse.json({ error: "Pausas indisponíveis (aplique as migrations 370 e 371)" }, { status: 503 });
  }
}
