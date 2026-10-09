import { trackCron } from "@/lib/ops/cron-heartbeat";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { registerAuditActor } from "@/lib/audit/context";
import { matchesOperationalSecret } from "@/lib/auth/operational-secret";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { runExportCron } from "@/lib/disparador/export-jobs";
import { runHistoryExportCron } from "@/lib/historico/export-jobs";

// POST /api/disparador/exports/cron — processa os jobs de exportação da fila em blocos retomáveis (stateless) e apaga os
// arquivos vencidos. Chamada pelo agendador externo (a cada minuto), com o mesmo segredo dos demais crons do Disparador:
//
//   curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" https://<host>/api/disparador/exports/cron
//
// Sem lock global: a reserva é por job (FOR UPDATE SKIP LOCKED + lease) — dois ticks não pegam o mesmo job, e um processo que
// cai deixa o lease vencer e o próximo tick continua do cursor salvo.

export const maxDuration = 120;

async function handlePost(request: Request) {
  await registerAuditActor({ actorType: "system", source: "cron_disparador_exports" });
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!matchesOperationalSecret(process.env.CRON_SECRET, request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const startedAt = Date.now();
    const summary = await runExportCron(supabaseAdmin(), { owner: randomUUID(), budgetMs: 60_000 });
    // Exportação do Histórico (TASK36): mesmo agendador; sem a migration 297 é no-op.
    const history = await runHistoryExportCron(supabaseAdmin(), { owner: randomUUID(), budgetMs: 20_000 }).catch((error) => {
      console.error("[ExportCron] Histórico:", error);
      return null;
    });
    return NextResponse.json({ status: summary.processed || history?.processed ? "processed" : "idle", ...summary, history, duration_ms: Date.now() - startedAt });
  } catch (error) {
    console.error("[ExportCron] Falha operacional:", error);
    return NextResponse.json({ error: "Export processing unavailable" }, { status: 503 });
  }
}

// Batimento do cron (D-12, migration 334): registra quando rodou e como terminou; não altera a resposta.
export async function POST(request: Request) {
  return trackCron("disparador_exports", () => handlePost(request))
}
