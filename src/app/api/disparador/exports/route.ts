import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { logAuditEvent } from "@/lib/audit/log-event";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { loadCampaignStatusCounts } from "@/lib/disparador/campaign-status-counts";
import { createExportJob, type ExportJob } from "@/lib/disparador/export-jobs";
import { toPublicExportJob } from "@/lib/disparador/export-job-public";
import { QUEUE_DETAIL_STATUS_FILTERS } from "@/lib/disparador/queue-status-filters";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";

export const dynamic = "force-dynamic";

// POST /api/disparador/exports   { campaign_id, status }  → 202 { job }   (cria/reaproveita o job; o cron processa)
// GET  /api/disparador/exports?campaign_id=<uuid>          → { jobs: [...] } (últimos 20 da conta)
// Contrato para o front em docs/disparador-exportacao-assincrona.md.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function estimateTotal(db: ReturnType<typeof supabaseAdmin>, campaignId: string, statusKey: string): Promise<number | null> {
  try {
    const counts = await loadCampaignStatusCounts(db, campaignId);
    if (!counts) return null;
    const wanted = statusKey === "total" ? null : new Set(QUEUE_DETAIL_STATUS_FILTERS[statusKey] ?? []);
    return Object.entries(counts).reduce((sum, [status, qty]) => (!wanted || wanted.has(status) ? sum + qty : sum), 0);
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireDisparadorAccess();
    const body = (await request.json().catch(() => null)) as { campaign_id?: unknown; status?: unknown } | null;
    const campaignId = typeof body?.campaign_id === "string" ? body.campaign_id : "";
    const statusKey = typeof body?.status === "string" ? body.status : "";
    if (!UUID_RE.test(campaignId) || !statusKey) {
      return NextResponse.json({ error: "Informe campaign_id e status." }, { status: 400 });
    }
    const db = supabaseAdmin();
    // A campanha precisa pertencer à conta do chamador.
    const { data: campaign } = await db.from("campaigns").select("id, account_id").eq("id", campaignId).maybeSingle();
    if (!campaign || campaign.account_id !== ctx.accountId) {
      return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
    }
    const total = await estimateTotal(db, campaignId, statusKey);
    const result = await createExportJob(db, {
      accountId: ctx.accountId,
      campaignId,
      userId: ctx.userId ?? null,
      statusKey,
      totalRows: total,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.message, code: result.code }, { status: result.code === "invalid_status" ? 400 : 503 });
    }
    await logAuditEvent({
      accountId: ctx.accountId,
      eventType: "action",
      resourceType: "campaign",
      resourceId: campaignId,
      action: "campaign.export_requested",
      summary: `Pediu exportação em segundo plano da métrica "${statusKey}"`,
      metadata: { status: statusKey, job_id: result.job.id },
    });
    return NextResponse.json({ job: toPublicExportJob(result.job) }, { status: 202 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function GET(request: Request) {
  try {
    const ctx = await requireDisparadorAccess();
    const campaignId = new URL(request.url).searchParams.get("campaign_id");
    let query = supabaseAdmin().from("dispatch_export_jobs").select("*").eq("account_id", ctx.accountId);
    if (campaignId && UUID_RE.test(campaignId)) query = query.eq("campaign_id", campaignId);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(20);
    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205") return NextResponse.json({ jobs: [], unavailable: true });
      throw new Error(`Falha ao listar exportações: ${error.message}`);
    }
    return NextResponse.json({ jobs: ((data ?? []) as ExportJob[]).map(toPublicExportJob) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
