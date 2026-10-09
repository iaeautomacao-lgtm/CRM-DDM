import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { registerAuditActor } from "@/lib/audit/context";
import { matchesOperationalSecret } from "@/lib/auth/operational-secret";
import { createDisparadorEnqueuer } from "@/lib/billing/enqueuer";
import { runBillingTick } from "@/lib/billing/engine";
import { createDdmDebtSource, ddmAllowance, resolveDdmToken } from "@/lib/billing/ddm-source";
import { supabaseAdmin } from "@/lib/disparador/admin-client";

// POST /api/billing/cron — um tick da régua de cobrança (PRD 17, PR 17.3). Agendador externo, a cada minuto, com o segredo dos crons:
//
//   curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" https://<host>/api/billing/cron
//
// Stateless; um tick por vez no cluster (try_acquire_cron_lock). Sem a migration 270–278 devolve 503. Régua DESLIGADA/em dry-run por
// padrão (e só ao ligar a régua, fora do dry-run, ela reserva e entrega ao disparador — PR 17.4).

export const maxDuration = 120;
const LOCK_TTL_SECONDS = 120;

export async function POST(request: Request) {
  await registerAuditActor({ actorType: "system", source: "cron_billing" });
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!matchesOperationalSecret(process.env.CRON_SECRET, request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const db = supabaseAdmin();
  const owner = randomUUID();
  let locked = false;
  try {
    const { data: acquired, error: lockError } = await db.rpc("try_acquire_cron_lock", { p_name: "billing_cron", p_owner_id: owner, p_ttl_seconds: LOCK_TTL_SECONDS });
    if (lockError) throw lockError;
    if (!acquired) return NextResponse.json({ status: "already_running" });
    locked = true;

    const startedAt = Date.now();
    const token = resolveDdmToken();
    const summary = await runBillingTick(
      {
        db,
        sourceFor: (accountId) => (token ? createDdmDebtSource({ token, allow: ddmAllowance(accountId) }) : null),
        enqueuer: createDisparadorEnqueuer(db),
      },
      { budgetMs: 80_000 },
    );
    return NextResponse.json({ status: summary.rulers ? "processed" : "idle", ...summary, duration_ms: Date.now() - startedAt });
  } catch (error) {
    console.error("[BillingCron] Falha operacional:", error instanceof Error ? error.message : "erro");
    return NextResponse.json({ error: "Billing tick unavailable" }, { status: 503 });
  } finally {
    if (locked) {
      try {
        await db.rpc("release_cron_lock", { p_name: "billing_cron", p_owner_id: owner });
      } catch {
        /* o TTL libera */
      }
    }
  }
}
