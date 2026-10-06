import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { resolveThroughputConfig } from "@/lib/disparador/throughput-config";
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
    await requireDisparadorAccess();

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

    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
