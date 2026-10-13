import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { toErrorResponse } from "@/lib/auth/account";
import { drainDispatchMoves } from "@/lib/disparador/queue-moves";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Pausar/encerrar: campaigns.manage pelo contexto completo (revisão de segurança 13/10, item 6): papel
    // personalizado, ajuste do cargo na organização, membro desativado e 2FA — antes decidia só pelo papel.
    const ctx = await requireDisparadorAccess();
    const profile = { account_id: ctx.accountId };

    const { id: campaignId } = await params;

    // Isolamento por conta: a campanha só é encontrada se pertencer à conta do usuário. Quem tem campaigns.manage
    // pausa/encerra qualquer campanha da conta (emergência), não só as próprias.
    const { data: campaignRows, error: campaignError } = await supabaseAdmin()
      .from("campaigns")
      .select("id")
      .eq("id", campaignId)
      .eq("account_id", ctx.accountId)
      .limit(1);

    if (campaignError || !campaignRows?.[0]) {
      return NextResponse.json(
        { error: "Campanha não encontrada" },
        { status: 404 }
      );
    }

    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "stop"; // 'stop' or 'pause'

    if (action !== "pause" && action !== "stop")
      return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
    // RPC transacional (migration 118): trava a campanha, muda o status e
    // pausa/cancela só itens agendado/pendente/pausado. Itens 'enviando'
    // não são tocados — podem já ter sido aceitos pelo provedor. Pausa só
    // é aceita em campanha 'em_execucao' (não em 'preparando').
    const { data: changed, error } = await supabaseAdmin().rpc(
      "stop_dispatch_campaign",
      {
        p_campaign_id: campaignId,
        p_account_id: profile.account_id,
        p_action: action,
      }
    );
    if (error) throw error;
    if (!changed)
      return NextResponse.json(
        { error: "Estado da campanha não permite a ação" },
        { status: 409 }
      );
    // A RPC só trocou o status (instantâneo; nenhum item é enviado a partir daqui). Os itens movem em lotes:
    // um orçamento curto aqui; o que sobrar (campanha muito grande) o cron termina.
    const moves = await drainDispatchMoves(supabaseAdmin(), campaignId, { budgetMs: 15_000 });
    return NextResponse.json({
      success: true,
      status: action === "pause" ? "pausada" : "encerrada",
      items_pending_move: moves.partial || !moves.ok,
    });
  } catch (err) {
    console.error("[Campaign Stop/Pause] Failed:", err);
    // 401/403 da autenticação com o code certo; o resto vira 500 genérico (sem detalhe interno).
    return toErrorResponse(err);
  }
}
