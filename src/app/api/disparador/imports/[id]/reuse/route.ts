import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { reuseImportList, type ImportJob } from "@/lib/disparador/import-lists";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";

export const dynamic = "force-dynamic";

// POST /api/disparador/imports/[id]/reuse   → 201 { draft_id, contacts, variables }
//
// Reutiliza uma lista importada (PRD 24, item 8) numa NOVA campanha: copia os vínculos e as variáveis VAR1–VAR3 da importação concluída para
// um rascunho novo e devolve o `draft_id`. O assistente cria a campanha com import_draft_id = draft_id (audience_mode "csv") e segue como
// qualquer importação — a lista de origem não muda e pode ser reutilizada de novo. Só da própria conta; importação não concluída = 409.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireDisparadorAccess();
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Importação não encontrada" }, { status: 404 });
    const db = supabaseAdmin();
    const { data } = await db.from("dispatch_import_jobs").select("*").eq("id", id).eq("account_id", ctx.accountId).maybeSingle();
    if (!data) return NextResponse.json({ error: "Importação não encontrada" }, { status: 404 });

    const result = await reuseImportList(db, data as ImportJob);
    if (!result.ok) return NextResponse.json({ error: result.message, code: result.code }, { status: result.status });
    return NextResponse.json({ draft_id: result.draftId, contacts: result.contacts, variables: result.variables }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
