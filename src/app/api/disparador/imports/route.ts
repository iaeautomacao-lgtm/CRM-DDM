import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import type { ColumnMap } from "@/lib/disparador/import-block";
import { createImportJob, draftBelongsToOtherAccount, toPublicImportJob, type ImportJob } from "@/lib/disparador/import-jobs";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";

export const dynamic = "force-dynamic";

// POST /api/disparador/imports  { campaign_id?, draft_id?, column_map, mapping_confirmed }  → 201 { job }
// GET  /api/disparador/imports?campaign_id=&draft_id=                                       → { jobs } (20 mais recentes da conta)
// Fluxo completo e contrato para o front em docs/disparador-importacao-assincrona.md.

const COLUMN_KEYS = ["name", "phone", "cpf", "var1", "var2", "var3"] as const;

export async function POST(request: Request) {
  try {
    const ctx = await requireDisparadorAccess();
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "Corpo da requisição inválido." }, { status: 400 });

    const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const columnMap: ColumnMap = {};
    const rawMap = (body.column_map && typeof body.column_map === "object" ? body.column_map : {}) as Record<string, unknown>;
    for (const key of COLUMN_KEYS) {
      const value = text(rawMap[key]);
      if (value) columnMap[key] = value;
    }
    const campaignId = text(body.campaign_id);
    const draftId = text(body.draft_id);
    const db = supabaseAdmin();

    if (draftId) {
      const foreign = await draftBelongsToOtherAccount(db, draftId, ctx.accountId);
      if (foreign === "error") return NextResponse.json({ error: "Falha ao verificar o rascunho." }, { status: 500 });
      if (foreign) return NextResponse.json({ error: "Rascunho não encontrado" }, { status: 404 });
    }

    const result = await createImportJob(db, {
      accountId: ctx.accountId,
      userId: ctx.userId ?? null,
      campaignId,
      draftId,
      columnMap,
      mappingConfirmed: body.mapping_confirmed === true || body.mapping_confirmed === "true",
    });
    if (!result.ok) return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
    return NextResponse.json({ job: toPublicImportJob(result.job) }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function GET(request: Request) {
  try {
    const ctx = await requireDisparadorAccess();
    const url = new URL(request.url);
    let query = supabaseAdmin().from("dispatch_import_jobs").select("*").eq("account_id", ctx.accountId);
    const campaignId = url.searchParams.get("campaign_id");
    const draftId = url.searchParams.get("draft_id");
    if (campaignId) query = query.eq("campaign_id", campaignId);
    if (draftId) query = query.eq("draft_id", draftId);
    const { data, error } = await query.order("created_at", { ascending: false }).limit(20);
    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205") return NextResponse.json({ jobs: [], unavailable: true });
      throw new Error(`Falha ao listar importações: ${error.message}`);
    }
    return NextResponse.json({ jobs: ((data ?? []) as ImportJob[]).map(toPublicImportJob) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
