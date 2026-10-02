import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/disparador/admin-client";

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

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("account_id")
      .eq("user_id", user.id)
      .maybeSingle();
    if (profileError || !profile?.account_id)
      return NextResponse.json(
        { error: "Conta indisponível" },
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

    if (campaign.created_by !== user.id) {
      return NextResponse.json(
        { error: "Você não tem permissão para executar esta campanha." },
        { status: 403 }
      );
    }

    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "stop"; // 'stop' or 'pause'

    if (action !== "pause" && action !== "stop")
      return NextResponse.json({ error: "Ação inválida" }, { status: 400 });
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
    return NextResponse.json({
      success: true,
      status: action === "pause" ? "pausada" : "encerrada",
    });
  } catch (err: any) {
    console.error("[Campaign Stop/Pause] Failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
