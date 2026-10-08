import { NextResponse, after } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { ensureQueueWorkerRunning } from "@/lib/disparador/worker";
import { startCampaign } from "@/lib/disparador/startCampaign";
import { canManageCampaigns } from "@/lib/disparador/route-auth";
import { kickDispatchCron } from "@/lib/disparador/dispatch-kick";
import { resolveCronBaseUrl } from "@/lib/disparador/tick-chain";
import { writeLog } from "@/lib/logger";
import { parseRedConfirmation } from "@/lib/disparador/red-quality-gate";

export const maxDuration = 60;

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
    let callerRole: string | null = null;
    let callerId: string | null = null;
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
        .select("account_id, account_role")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!profile?.account_id) {
        return NextResponse.json(
          { error: "Seu perfil não está vinculado a uma conta." },
          { status: 400 }
        );
      }
      // Iniciar / "Iniciar agora" / retomar: só quem gerencia campanhas
      // (owner/admin, mesmo papel da página /disparador — route-auth.ts).
      if (!canManageCampaigns(profile.account_role)) {
        return NextResponse.json(
          { error: "Seu papel não permite gerenciar campanhas do disparador." },
          { status: 403 }
        );
      }
      accountId = profile.account_id;
      callerRole = profile.account_role ?? null;
      callerId = user.id;

      // wacrm.campaigns has no account_id column (only created_by), so
      // "mesma conta" é resolvido via o profile do criador. Donos/admins
      // podem iniciar qualquer campanha da própria conta; agents/viewers
      // só a que eles mesmos criaram.
      if (campaign.created_by !== user.id) {
        const isPrivilegedRole =
          profile.account_role === "owner" || profile.account_role === "admin";

        let sameAccountAsCreator = false;
        if (isPrivilegedRole && campaign.created_by) {
          const { data: creatorProfile } = await supabase
            .from("profiles")
            .select("account_id")
            .eq("user_id", campaign.created_by)
            .maybeSingle();
          sameAccountAsCreator = creatorProfile?.account_id === profile.account_id;
        }

        if (!isPrivilegedRole || !sameAccountAsCreator) {
          return NextResponse.json(
            { error: "Você não tem permissão para executar esta campanha." },
            { status: 403 }
          );
        }
      }
    }

    ensureQueueWorkerRunning();

    // "Iniciar agora" numa campanha agendada ({ agora: true }): a fila começa
    // agora, não no horário agendado. Corpo vazio/inválido = início normal.
    // Número em qualidade vermelha: só o owner inicia, com confirm_red_quality: true + red_quality_reason.
    const body = (await request.json().catch(() => null)) as
      | { agora?: unknown; confirm_red_quality?: unknown; red_quality_reason?: unknown }
      | null;
    const result = await startCampaign(campaignId, accountId, {
      startNow: body?.agora === true,
      redConfirmation: parseRedConfirmation(callerRole, callerId, body),
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, ...(result.code ? { code: result.code, channels: result.channels ?? [] } : {}) },
        { status: result.status }
      );
    }

    // Campanha manual acabava dependendo do próximo cron de 1 minuto.
    // Exemplo real: a fila foi publicada ~360 ms depois do tick das 16:01,
    // então 967 envios ficaram parados até 16:02. Acordamos o MESMO cron em
    // after(), depois de responder ao usuário. Não criamos um worker novo:
    // lock global, claims atômicos, backoff, limites e telemetria continuam
    // todos no /api/disparador/cron.
    if (!isInternalCall) {
      // Origem do app vem do ambiente da plataforma, NUNCA do Host/URL desta requisição (o x-cron-secret vai nela).
      const baseUrl = resolveCronBaseUrl();
      after(async () => {
        const startedAt = Date.now();
        const kick = await kickDispatchCron({
          baseUrl,
          secret: process.env.CRON_SECRET,
        });
        await writeLog({
          account_id: accountId,
          level: kick.outcome === "failed" ? "warn" : "info",
          source: "disparador",
          event: "campaign_dispatch_kick",
          message:
            kick.outcome === "triggered"
              ? "Motor do disparador acionado após início manual"
              : kick.outcome === "busy"
                ? "Motor já estava ocupado; cron agendado permanece como fallback"
                : kick.outcome === "skipped"
                  ? "Kick imediato não configurado; cron agendado permanece como fallback"
                  : "Falha no kick imediato; cron agendado permanece como fallback",
          payload: {
            campaign_id: campaignId,
            outcome: kick.outcome,
            attempts: kick.attempts,
            cron_status: kick.cronStatus ?? null,
            http_status: kick.httpStatus ?? null,
            elapsed_ms: Date.now() - startedAt,
          },
        });
      });
    }

    return NextResponse.json({ success: true, enqueued: result.enqueued });
  } catch (err: any) {
    console.error("[Campaign Start] Failed to schedule queue:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
