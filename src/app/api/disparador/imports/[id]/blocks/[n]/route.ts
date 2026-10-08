import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { putImportBlock, toPublicImportJob, type ImportJob } from "@/lib/disparador/import-jobs";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";

export const dynamic = "force-dynamic";

// PUT /api/disparador/imports/[id]/blocks/[n]  { rows: [{cabeçalho: valor}, …] }  (até 10.000 linhas)
// Guarda as linhas do bloco n (0, 1, 2…) — rápido, sem processar nada. Reenviar o mesmo bloco substitui (idempotente).

export async function PUT(request: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  try {
    const ctx = await requireDisparadorAccess();
    const { id, n } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Importação não encontrada" }, { status: 404 });
    const db = supabaseAdmin();
    const { data } = await db.from("dispatch_import_jobs").select("*").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    if (!data) return NextResponse.json({ error: "Importação não encontrada" }, { status: 404 });
    const body = (await request.json().catch(() => null)) as { rows?: unknown } | null;
    const result = await putImportBlock(db, data as ImportJob, Number(n), body?.rows);
    if (!result.ok) return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
    return NextResponse.json({ job: toPublicImportJob(result.job) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
