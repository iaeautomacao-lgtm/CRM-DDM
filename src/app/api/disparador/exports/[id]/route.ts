import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { signedDownloadUrl, type ExportJob } from "@/lib/disparador/export-jobs";
import { toPublicExportJob } from "@/lib/disparador/export-job-public";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";

export const dynamic = "force-dynamic";

// GET /api/disparador/exports/[id]              → { job } (estado e progresso)
// GET /api/disparador/exports/[id]?download=1   → { job, download: { url, expires_in_seconds } } — link assinado e curto;
//   409 se ainda não terminou, 410 se o arquivo expirou.

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireDisparadorAccess();
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Exportação não encontrada" }, { status: 404 });
    const db = supabaseAdmin();
    const { data } = await db.from("dispatch_export_jobs").select("*").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    const job = data as ExportJob | null;
    if (!job) return NextResponse.json({ error: "Exportação não encontrada" }, { status: 404 });
    const publicJob = toPublicExportJob(job);

    if (new URL(request.url).searchParams.get("download") !== "1") return NextResponse.json({ job: publicJob });

    if (job.state === "expired" || (job.state === "done" && job.expires_at && Date.parse(job.expires_at) <= Date.now())) {
      return NextResponse.json({ error: "O arquivo expirou; gere a exportação de novo.", code: "expired", job: publicJob }, { status: 410 });
    }
    if (job.state !== "done") {
      return NextResponse.json({ error: "A exportação ainda não terminou.", code: "not_ready", job: publicJob }, { status: 409 });
    }
    const link = await signedDownloadUrl(db, job);
    if (!link) return NextResponse.json({ error: "Não foi possível gerar o link de download.", code: "unavailable" }, { status: 503 });
    return NextResponse.json({ job: publicJob, download: { url: link.url, expires_in_seconds: link.expiresInSeconds } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
