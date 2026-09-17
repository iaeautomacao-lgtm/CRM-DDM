import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { ensureQueueWorkerRunning } from "@/lib/disparador/worker";
import { startCampaign } from "@/lib/disparador/startCampaign";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: campaignId } = await params;

    // Permite chamada interna do cron (sem sessão de usuário) para
    // disparar campanhas agendadas — ver /api/disparador/cron.
    const internalCronSecret = request.headers.get("x-internal-cron");
    const isInternalCall =
      internalCronSecret === process.env.CRON_SECRET && !!process.env.CRON_SECRET;

    // Fetch apenas o necessário pra resolver a conta (buscado uma única
    // vez, antes de ramificar a autenticação — a chamada interna do cron
    // também precisa desta linha pra resolver created_by/account_id). A
    // validação completa da campanha e o enfileiramento em si ficam em
    // startCampaign(), reutilizada pelo cron pra auto-start sem round-trip
    // HTTP — ver src/lib/disparador/startCampaign.ts.
    const { data: campaign, error: campaignError } = await supabaseAdmin()
      .from("campaigns")
      .select("id, created_by")
      .eq("id", campaignId)
      .single();

    if (campaignError || !campaign) {
      return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
    }

    let accountId: string;
    if (isInternalCall) {
      // Sem sessão de usuário — resolve a conta via created_by ->
      // profiles.account_id. wacrm.campaigns não tem account_id
      // (migration 040 não aplicada), então não há como ler isso
      // direto da linha da campanha.
      if (!campaign.created_by) {
        return NextResponse.json(
          { error: "Campanha sem criador definido, não é possível resolver a conta." },
          { status: 400 }
        );
      }
      const { data: creatorProfile } = await supabaseAdmin()
        .from("profiles")
        .select("account_id")
        .eq("user_id", campaign.created_by)
        .maybeSingle();
      if (!creatorProfile?.account_id) {
        return NextResponse.json(
          { error: "Criador da campanha não está vinculado a uma conta." },
          { status: 400 }
        );
      }
      accountId = creatorProfile.account_id;
    } else {
      const supabase = await createServerClient();
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();
      if (authError || !user) {
        return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
      }

      // wacrm.campaigns has no account_id column yet (see migration 040,
      // not yet applied), so resolve the caller's account_id from their
      // profile to scope the contacts query below.
      const { data: profile } = await supabase
        .from("profiles")
        .select("account_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!profile?.account_id) {
        return NextResponse.json(
          { error: "Seu perfil não está vinculado a uma conta." },
          { status: 400 }
        );
      }
      accountId = profile.account_id;

      // wacrm.campaigns has no account_id column (only created_by), so
      // ownership is checked per-user rather than per-account for now.
      if (campaign.created_by !== user.id) {
        return NextResponse.json(
          { error: "Você não tem permissão para executar esta campanha." },
          { status: 403 }
        );
      }
    }

    ensureQueueWorkerRunning();

    const result = await startCampaign(campaignId, accountId);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ success: true, enqueued: result.enqueued });
  } catch (err: any) {
    console.error("[Campaign Start] Failed to schedule queue:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
