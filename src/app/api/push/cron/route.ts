import { NextResponse } from "next/server";
import { registerAuditActor } from "@/lib/audit/context";
import { matchesOperationalSecret } from "@/lib/auth/operational-secret";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { drainPushOutbox } from "@/lib/push/service";

export const maxDuration = 30;

// POST /api/push/cron — rede de segurança: entrega os avisos de "conversa em espera" que o after() do webhook não entregou. Mesmo
// segredo dos demais crons (x-cron-secret). O caminho normal é o after() do webhook da Meta (latência de segundos).
export async function POST(request: Request) {
  await registerAuditActor({ actorType: "system", source: "cron_push" });
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!matchesOperationalSecret(process.env.CRON_SECRET, request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await drainPushOutbox(supabaseAdmin(), { limit: 100 }));
}
