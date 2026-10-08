import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { toPublicImportJob, type ImportJob } from "@/lib/disparador/import-jobs";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";

export const dynamic = "force-dynamic";

// GET /api/disparador/imports/[id] → { job } (estado, progresso, totais e erros por linha). Só da própria conta.

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireDisparadorAccess();
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Importação não encontrada" }, { status: 404 });
    const { data } = await supabaseAdmin().from("dispatch_import_jobs").select("*").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    if (!data) return NextResponse.json({ error: "Importação não encontrada" }, { status: 404 });
    return NextResponse.json({ job: toPublicImportJob(data as ImportJob) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
