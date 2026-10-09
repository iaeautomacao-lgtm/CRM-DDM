import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { registerAuditActor } from "@/lib/audit/context";
import { matchesOperationalSecret } from "@/lib/auth/operational-secret";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { drainWebhookDeliveries } from "@/lib/webhooks-out/deliver";

// POST /api/webhooks-out/cron — entrega os webhooks de saída pendentes (PRD 15, 15.14). Agendador externo, a cada minuto, com o
// mesmo segredo dos demais crons:
//
//   curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" https://<host>/api/webhooks-out/cron
//
// Stateless: a reserva é por entrega (FOR UPDATE SKIP LOCKED + lease de 120 s) — dois ticks não pegam a mesma, e um processo que cai
// deixa o lease vencer. Sem a migration 204 devolve 503 (nada quebra).

export const maxDuration = 120;

export async function POST(request: Request) {
  await registerAuditActor({ actorType: "system", source: "cron_webhooks_out" });
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!matchesOperationalSecret(process.env.CRON_SECRET, request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const startedAt = Date.now();
    const summary = await drainWebhookDeliveries(supabaseAdmin(), { owner: randomUUID(), budgetMs: 80_000 });
    return NextResponse.json({ status: summary.claimed ? "processed" : "idle", ...summary, duration_ms: Date.now() - startedAt });
  } catch (error) {
    console.error("[WebhooksOutCron] Falha operacional:", error instanceof Error ? error.message : "erro");
    return NextResponse.json({ error: "Webhook delivery unavailable" }, { status: 503 });
  }
}
