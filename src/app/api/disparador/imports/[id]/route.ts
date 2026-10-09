import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { parseListName, toPublicImportJob, type ImportJob } from "@/lib/disparador/import-jobs";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";

export const dynamic = "force-dynamic";

// GET   /api/disparador/imports/[id] → { job } (estado, progresso, totais e erros por linha). Só da própria conta.
// PATCH /api/disparador/imports/[id]  { name }  → { job }  — dá nome (ou renomeia) a lista importada (PRD 24, item 8; migration 292). name: null/"" remove.

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

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireDisparadorAccess();
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Importação não encontrada" }, { status: 404 });
    const body = (await request.json().catch(() => null)) as { name?: unknown } | null;
    if (!body || !("name" in body)) return NextResponse.json({ error: "Informe name." }, { status: 400 });
    const parsed = parseListName(body.name);
    if (parsed === null) return NextResponse.json({ error: "Nome da lista inválido (1 a 120 caracteres).", code: "invalid_name" }, { status: 400 });

    const { data, error } = await supabaseAdmin()
      .from("dispatch_import_jobs")
      .update({ name: parsed ?? null })
      .eq("id", id)
      .eq("account_id", ctx.accountId)
      .select("*")
      .limit(1);
    if (error) {
      if (error.code === "42703" || error.code === "PGRST204") {
        return NextResponse.json({ error: "Recurso indisponível: aplique a migration 292.", code: "unavailable" }, { status: 503 });
      }
      throw new Error(`Falha ao renomear a lista: ${error.message}`);
    }
    const job = (data as ImportJob[] | null)?.[0];
    if (!job) return NextResponse.json({ error: "Importação não encontrada" }, { status: 404 });
    return NextResponse.json({ job: toPublicImportJob(job) });
  } catch (err) {
    return toErrorResponse(err);
  }
}
