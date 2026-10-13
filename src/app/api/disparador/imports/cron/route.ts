import { trackCron } from "@/lib/ops/cron-heartbeat";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { registerAuditActor } from "@/lib/audit/context";
import { matchesOperationalSecret } from "@/lib/auth/operational-secret";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { runImportCron } from "@/lib/disparador/import-jobs";

// POST /api/disparador/imports/cron — processa os jobs de importação de contatos em blocos retomáveis (stateless) e cancela os
// que ficaram abandonados. Chamada pelo agendador externo (a cada minuto), com o mesmo segredo dos demais crons do Disparador:
//
//   curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" https://<host>/api/disparador/imports/cron
//
// Sem lock global: a reserva é por job (FOR UPDATE SKIP LOCKED + lease) — dois ticks não pegam o mesmo job, e um processo que
// cai deixa o lease vencer e o próximo tick continua do bloco em curso (cada bloco é idempotente).

export const maxDuration = 120;

async function handlePost(request: Request) {
  await registerAuditActor({ actorType: "system", source: "cron_disparador_imports" });
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!matchesOperationalSecret(process.env.CRON_SECRET, request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const startedAt = Date.now();
    const summary = await runImportCron(supabaseAdmin(), { owner: randomUUID(), budgetMs: 80_000 });
    return NextResponse.json({ status: summary.processed ? "processed" : "idle", ...summary, duration_ms: Date.now() - startedAt });
  } catch (error) {
    console.error("[ImportCron] Falha operacional:", error);
    return NextResponse.json({ error: "Import processing unavailable" }, { status: 503 });
  }
}

// Batimento do cron (D-12, migration 334): registra quando rodou e como terminou; não altera a resposta.
export async function POST(request: Request) {
  return trackCron("disparador_imports", () => handlePost(request))
}
