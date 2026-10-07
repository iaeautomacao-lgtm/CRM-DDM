import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { registerAuditActor } from "@/lib/audit/context";
import { matchesOperationalSecret } from "@/lib/auth/operational-secret";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { prepareDueCampaigns, recoverStuckPreparing } from "@/lib/disparador/prepare-campaigns";

// POST /api/disparador/prepare/cron — prepara (startCampaign) as campanhas
// `agendado` cujo horário chegou, FORA do tick de envio (B9). Chamada pelo
// agendador externo a cada minuto, com o mesmo segredo do cron de envio
// (header x-cron-secret):
//
//   curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" \
//     https://<host>/api/disparador/prepare/cron
//
// Lock próprio `disparador_prepare`: nunca duas preparações ao mesmo tempo,
// e a preparação não segura o lock do tick de envio (que segue enviando).
// Preparação de uma campanha grande pode passar de minutos: o lock é
// renovado enquanto a requisição vive (o setInterval morre com ela — não é
// worker em memória) e o TTL cobre um crash.

export const maxDuration = 300;

const LOCK_NAME = "disparador_prepare";
// TTL curto: o heartbeat (renew_cron_lock, 20 s) mantém o lock durante o preparo; crash libera em ~1,5 min (migration 184).
const LOCK_TTL_SECONDS = 90;
const DEFAULT_BUDGET_MS = 240_000;

function budgetMs(): number {
  const parsed = Number(process.env.DISPARADOR_PREPARE_BUDGET_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_BUDGET_MS;
}

function authorize(request: Request): NextResponse | null {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!matchesOperationalSecret(process.env.CRON_SECRET, request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(request: Request) {
  await registerAuditActor({ actorType: "system", source: "cron_disparador_prepare" });
  const rejection = authorize(request);
  if (rejection) return rejection;

  const owner = randomUUID();
  let locked = false;
  let lostLease = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const startedAt = Date.now();
  const stopAt = startedAt + budgetMs();
  const outOfTime = () => lostLease || Date.now() > stopAt;

  try {
    const db = supabaseAdmin();
    const { data: acquired, error: lockError } = await db.rpc("try_acquire_cron_lock", {
      p_name: LOCK_NAME,
      p_owner_id: owner,
      p_ttl_seconds: LOCK_TTL_SECONDS,
    });
    if (lockError) throw lockError;
    if (!acquired) return NextResponse.json({ status: "already_running" });
    locked = true;

    heartbeat = setInterval(() => {
      void (async () => {
        try {
          const { data, error } = await db.rpc("renew_cron_lock", { p_name: LOCK_NAME, p_owner: owner });
          if (error || !data) lostLease = true;
        } catch {
          lostLease = true;
        }
      })();
    }, 20_000);

    const recovered = await recoverStuckPreparing(db);
    const report = await prepareDueCampaigns(db, { outOfTime });
    return NextResponse.json({
      status: report.attempted ? "prepared" : "idle",
      recovered,
      attempted: report.attempted,
      prepared: report.prepared,
      failed: report.failed,
      results: report.results,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    console.error("[Prepare] Falha operacional:", error);
    return NextResponse.json({ error: "Campaign preparation unavailable" }, { status: 503 });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (locked) {
      try {
        const { error } = await supabaseAdmin().rpc("release_cron_lock", { p_name: LOCK_NAME, p_owner_id: owner });
        if (error) console.error("[Prepare] Falha ao liberar lock:", error.message);
      } catch (error) {
        console.error("[Prepare] Falha ao liberar lock:", error);
      }
    }
  }
}
