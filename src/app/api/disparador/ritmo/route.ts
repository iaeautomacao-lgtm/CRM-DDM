import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { resolveThroughputConfig } from "@/lib/disparador/throughput-config";
import { listRateLimits } from "@/lib/disparador/rate-limits-service";
import { computeRitmo, type RawSystemLogTick } from "@/lib/disparador/ritmo";

// ============================================================
// GET /api/disparador/ritmo
//
// Retorna os limites ativos do motor (do último cron_tick gravado
// em system_logs) e a latência de envio da Meta e do WAHA nas
// últimas 24h.
//
// Acesso: restrito a owner e admin (requireDisparadorAccess).
// Se não houver telemetria recente, responde com padrões seguros
// (Meta 0,85s, WAHA 2s).
// ============================================================

export async function GET() {
  try {
    const ctx = await requireDisparadorAccess();

    const db = supabaseAdmin();
    const cutoffIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    const { data: rows, error } = await db
      .from("system_logs")
      .select("id, created_at, payload")
      .eq("source", "disparador")
      .eq("event", "cron_tick")
      .gte("created_at", cutoffIso)
      .order("created_at", { ascending: false })
      .limit(1500);

    if (error) {
      console.warn("[Ritmo] Falha ao consultar telemetria em system_logs:", error.message);
    }

    const fallbackConfig = resolveThroughputConfig();
    const result = computeRitmo((rows ?? []) as RawSystemLogTick[], fallbackConfig);

    // Limite/s efetivo dos números Meta (conservador: o menor). Sem migration 190/sem linhas, segue sem limite por segundo.
    let metaRate: number | null = null;
    try {
      const view = await listRateLimits(db, ctx.accountId);
      const rates = view.channels.map((c) => c.rate?.effective).filter((r): r is number => typeof r === "number" && r > 0);
      if (rates.length) metaRate = Math.min(...rates);
    } catch {
      metaRate = null;
    }

    return NextResponse.json({ ...result, meta_rate_per_second: metaRate });
  } catch (err) {
    return toErrorResponse(err);
  }
}
