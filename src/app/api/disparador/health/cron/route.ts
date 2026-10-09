import { trackCron } from "@/lib/ops/cron-heartbeat";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { registerAuditActor } from "@/lib/audit/context";
import { matchesOperationalSecret } from "@/lib/auth/operational-secret";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { pollChannelHealth } from "@/lib/disparador/channel-health";

// POST /api/disparador/health/cron — poll de segurança da saúde dos números Meta (P1-5): lê qualidade/tier/throughput no Graph,
// grava channel_health e recalcula o limite/s automático. Complementa o webhook phone_number_quality_update (que pode atrasar ou
// não chegar). Chamada pelo agendador externo a cada 5–10 min, com o mesmo segredo dos outros crons:
//
//   curl -fsS -X POST -H "x-cron-secret: $CRON_SECRET" https://<host>/api/disparador/health/cron
//
// Stateless (sem worker em memória): lock próprio `disparador_health` com TTL curto; só re-consulta quem foi lido há mais de ~4 min.
// Sem as tabelas da migration 190, devolve { status: "idle", tables_missing: true } e não faz nada.

export const maxDuration = 120;

const LOCK_NAME = "disparador_health";
const LOCK_TTL_SECONDS = 90;
const BUDGET_MS = 90_000;

function authorize(request: Request): NextResponse | null {
  if (!process.env.CRON_SECRET) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!matchesOperationalSecret(process.env.CRON_SECRET, request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

async function handlePost(request: Request) {
  await registerAuditActor({ actorType: "system", source: "cron_disparador_health" });
  const rejection = authorize(request);
  if (rejection) return rejection;

  const owner = randomUUID();
  let locked = false;
  let lostLease = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const startedAt = Date.now();
  const outOfTime = () => lostLease || Date.now() - startedAt > BUDGET_MS;

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

    const report = await pollChannelHealth(db, { outOfTime });
    return NextResponse.json({
      status: report.skipped_tables_missing ? "idle" : report.refreshed ? "refreshed" : "idle",
      tables_missing: report.skipped_tables_missing,
      considered: report.considered,
      refreshed: report.refreshed,
      changed: report.changed,
      failed: report.failed,
      duration_ms: Date.now() - startedAt,
    });
  } catch (error) {
    console.error("[ChannelHealth] Falha operacional do poll:", error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Channel health poll unavailable" }, { status: 503 });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (locked) {
      try {
        const { error } = await supabaseAdmin().rpc("release_cron_lock", { p_name: LOCK_NAME, p_owner_id: owner });
        if (error) console.error("[ChannelHealth] Falha ao liberar lock:", error.message);
      } catch (error) {
        console.error("[ChannelHealth] Falha ao liberar lock:", error);
      }
    }
  }
}

// Batimento do cron (D-12, migration 334): registra quando rodou e como terminou; não altera a resposta.
export async function POST(request: Request) {
  return trackCron("disparador_health", () => handlePost(request))
}
