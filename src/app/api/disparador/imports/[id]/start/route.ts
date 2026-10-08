import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { logAuditEvent } from "@/lib/audit/log-event";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { startImportJob, toPublicImportJob, type ImportJob } from "@/lib/disparador/import-jobs";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";

export const dynamic = "force-dynamic";

// POST /api/disparador/imports/[id]/start  { total_blocks }  → 202 { job }
// Confere que os blocos 0..total_blocks-1 chegaram e libera o job para o cron processar em segundo plano.

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireDisparadorAccess();
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Importação não encontrada" }, { status: 404 });
    const db = supabaseAdmin();
    const { data } = await db.from("dispatch_import_jobs").select("*").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    if (!data) return NextResponse.json({ error: "Importação não encontrada" }, { status: 404 });
    const body = (await request.json().catch(() => null)) as { total_blocks?: unknown } | null;
    const result = await startImportJob(db, data as ImportJob, body?.total_blocks);
    if (!result.ok) return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
    await logAuditEvent({
      accountId: ctx.accountId,
      eventType: "action",
      resourceType: result.job.campaign_id ? "campaign" : "contacts_import",
      resourceId: result.job.campaign_id ?? result.job.id,
      action: "contacts.import_requested",
      summary: `Iniciou importação em segundo plano (${result.job.rows_total} linhas, ${result.job.blocks_total} bloco(s))`,
      metadata: { job_id: result.job.id, rows: result.job.rows_total, blocks: result.job.blocks_total, draft_id: result.job.draft_id },
    });
    return NextResponse.json({ job: toPublicImportJob(result.job) }, { status: 202 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
