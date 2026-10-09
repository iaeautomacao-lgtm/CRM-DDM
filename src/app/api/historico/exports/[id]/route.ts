import { NextResponse } from "next/server";
import { requirePermission, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { historyExportDownloadUrl, toPublicHistoryExportJob, type HistoryExportJob } from "@/lib/historico/export-jobs";

export const dynamic = "force-dynamic";

// GET /api/historico/exports/[id]             → { job } (estado e progresso)
// GET /api/historico/exports/[id]?download=1  → { job, download: { url, expires_in_seconds } } — link assinado e curto;
//   409 se ainda não terminou, 404 se a exportação foi apagada em Exportações (o arquivo some junto).
// Só exports.manage (admin e proprietário).
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requirePermission("exports.manage");
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Exportação não encontrada" }, { status: 404 });
    const db = supabaseAdmin();
    const { data } = await db.from("history_export_jobs").select("*").eq("id", id).eq("account_id", ctx.accountId).limit(1);
    const job = (data?.[0] ?? null) as HistoryExportJob | null;
    if (!job) return NextResponse.json({ error: "Exportação não encontrada" }, { status: 404 });
    const publicJob = toPublicHistoryExportJob(job);
    if (new URL(request.url).searchParams.get("download") !== "1") return NextResponse.json({ job: publicJob });

    if (job.state !== "done") {
      return NextResponse.json({ error: "A exportação ainda não terminou.", code: "not_ready", job: publicJob }, { status: 409 });
    }
    const link = await historyExportDownloadUrl(db, job);
    if (!link) return NextResponse.json({ error: "Arquivo indisponível (pode ter sido apagado em Exportações).", code: "unavailable" }, { status: 404 });
    return NextResponse.json({ job: publicJob, download: { url: link.url, expires_in_seconds: link.expiresInSeconds } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
