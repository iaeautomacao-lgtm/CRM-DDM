import { NextResponse } from "next/server";
import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { logAuditEvent } from "@/lib/audit/log-event";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { createHistoryExportJob, parseHistoryExportRequest, toPublicHistoryExportJob, type HistoryExportJob } from "@/lib/historico/export-jobs";

export const dynamic = "force-dynamic";

// POST /api/historico/exports  { period_from, period_to, tabulacao_id? }  → 202 { job }   (TASK36 item 2)
//   Exporta as conversas ENCERRADAS com closed_at em [period_from, period_to) (ISO; to exclusivo, até 366 dias), opcionalmente só as
//   de uma tabulação. Job assíncrono (cron stateless); ao concluir o CSV aparece em Exportações (export_history).
// GET  /api/historico/exports → { jobs: [...] } (últimos 20 da conta)
// Só exports.manage (admin e proprietário), como o histórico de exportações.
export async function POST(request: Request) {
  try {
    const ctx = await requirePermission("exports.manage");
    const parsed = parseHistoryExportRequest(await request.json().catch(() => null));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

    const result = await createHistoryExportJob(supabaseAdmin(), {
      accountId: ctx.accountId,
      userId: ctx.userId ?? null,
      from: parsed.from,
      to: parsed.to,
      tabulacaoId: parsed.tabulacaoId,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.message, code: result.code }, { status: result.code === "tabulacao_not_found" ? 404 : 503 });
    }
    if (!result.reused) {
      await logAuditEvent({
        accountId: ctx.accountId,
        eventType: "action",
        resourceType: "export",
        resourceId: result.job.id,
        action: "history.export_requested",
        summary: "Pediu a exportação do Histórico de conversas encerradas",
        metadata: { period_from: parsed.from, period_to: parsed.to, tabulacao_id: parsed.tabulacaoId },
      });
    }
    return NextResponse.json({ job: toPublicHistoryExportJob(result.job) }, { status: 202 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function GET() {
  try {
    const ctx = await requirePermission("exports.manage");
    const { data, error } = await supabaseAdmin().from("history_export_jobs").select("*").eq("account_id", ctx.accountId).order("created_at", { ascending: false }).limit(20);
    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205") return NextResponse.json({ jobs: [], unavailable: true });
      throw new Error(`Falha ao listar exportações: ${error.message}`);
    }
    return NextResponse.json({ jobs: ((data ?? []) as HistoryExportJob[]).map(toPublicHistoryExportJob) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
