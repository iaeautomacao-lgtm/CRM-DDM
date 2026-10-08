import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { ErrosInputError, loadErroDetail, type ErrosDb } from "@/lib/disparador/erros";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" } as const;

// GET /api/disparador/erros/[id] — detalhe de um item em erro (drawer): linha do tempo, explicação do
// catálogo, recibos do webhook, 131026 pendente, campanha/número/template. Só leitura, escopado pela conta
// (item de outra conta = 404, igual a inexistente).
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireDisparadorAccess();
    const { id } = await ctx.params;
    const detail = await loadErroDetail(supabaseAdmin() as unknown as ErrosDb, accountId, id);
    return NextResponse.json({ ok: true, detail }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof ErrosInputError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status, headers: NO_STORE });
    }
    const response = toErrorResponse(err);
    response.headers.set("Cache-Control", "no-store, max-age=0");
    return response;
  }
}
