import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { supabaseAdmin } from "@/lib/disparador/admin-client";

// POST /api/disparador/campaigns/[id]/unschedule — "Desagendar": a campanha
// agendada volta para rascunho (sem agendamento) e pode ser editada ou
// iniciada à mão. Condicionado a status = 'agendado': se o cron já começou
// a prepará-la, nada muda e a resposta é 409.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireDisparadorAccess();
    const { id } = await params;

    const { data, error } = await supabaseAdmin()
      .from("campaigns")
      .update({ status: "rascunho", agendamento: null, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("account_id", accountId)
      .eq("status", "agendado")
      .select("id");
    if (error) {
      console.error("[Campaign Unschedule]", error.message);
      return NextResponse.json({ error: "Não foi possível desagendar a campanha." }, { status: 500 });
    }
    if (!data || data.length === 0) {
      return NextResponse.json(
        { error: "A campanha não está mais agendada (pode já ter começado). Atualize a página." },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: true, status: "rascunho" });
  } catch (err) {
    return toErrorResponse(err);
  }
}
