import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { canManageCampaigns } from "@/lib/disparador/route-auth";
import { drainDispatchMoves } from "@/lib/disparador/queue-moves";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createServerClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    const { id: campaignId } = await params;

    // Isolamento por conta: a campanha só é encontrada se pertencer à conta
    // do usuário (antes só o created_by era conferido, sem escopo de conta).
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("account_id, account_role")
      .eq("user_id", user.id)
      .maybeSingle();
    if (profileError || !profile?.account_id)
      return NextResponse.json(
        { error: "Conta indisponível" },
        { status: 403 }
      );
    // Pausar/encerrar: só quem gerencia campanhas (owner/admin, mesmo papel
    // da página /disparador — route-auth.ts).
    if (!canManageCampaigns(profile.account_role))
      return NextResponse.json(
        { error: "Seu papel não permite gerenciar campanhas do disparador." },
        { status: 403 }
      );
    const { data: campaign, error: campaignError } = await supabaseAdmin()
      .from("campaigns")
      .select("id, created_by")
      .eq("id", campaignId)
      .eq("account_id", profile.account_id)
      .single();

    if (campaignError || !campaign) {
      return NextResponse.json(
        { error: "Campanha não encontrada" },
        { status: 404 }
      );
    }

    // Mesma regra do iniciar: o criador ou owner/admin da conta (a campanha
    // já foi escopada à conta acima). Antes só o criador — um admin não
    // conseguia frear em emergência a campanha de um colega.
    const isPrivilegedRole =
      profile.account_role === "owner" || profile.account_role === "admin";
    if (campaign.created_by !== user.id && !isPrivilegedRole) {
      return NextResponse.json(
        { error: "Você não tem permissão para executar esta campanha." },
        { status: 403 }
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
  } catch (err: any) {
    console.error("[Campaign Stop/Pause] Failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
