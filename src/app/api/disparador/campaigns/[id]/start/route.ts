import { NextResponse, after } from "next/server";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { ensureQueueWorkerRunning } from "@/lib/disparador/worker";
import { startCampaign } from "@/lib/disparador/startCampaign";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { toErrorResponse } from "@/lib/auth/account";
import { kickDispatchCron } from "@/lib/disparador/dispatch-kick";
import { resolveCronBaseUrl } from "@/lib/disparador/tick-chain";
import { writeLog } from "@/lib/logger";
import { parseRedConfirmation } from "@/lib/disparador/red-quality-gate";
import { matchesOperationalSecret } from "@/lib/auth/operational-secret";
import { enforceRateLimit } from "@/lib/api/guards";
import { RATE_LIMITS } from "@/lib/rate-limit";

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
    // Tempo constante e fail-closed (PRD 14, SG-10). Nenhum código do repositório envia este
    // header hoje (o cron chama startCampaign() direto): o ramo está efetivamente morto.
    const isInternalCall = matchesOperationalSecret(process.env.CRON_SECRET, internalCronSecret);

    // Fetch apenas o necessário pra resolver a conta (buscado uma única
    // vez, antes de ramificar a autenticação — a chamada interna do cron
    // também precisa desta linha pra resolver created_by/account_id). A
    // validação completa da campanha e o enfileiramento em si ficam em
    // startCampaign(), reutilizada pelo cron pra auto-start sem round-trip
    // HTTP — ver src/lib/disparador/startCampaign.ts.
    const { data: campaignRows, error: campaignError } = await supabaseAdmin()
      .from("campaigns")
      .select("id, created_by")
      .eq("id", campaignId)
      .limit(1);
    const campaign = campaignRows?.[0] as { id: string; created_by: string | null } | undefined;

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
      // Iniciar / "Iniciar agora" / retomar: campaigns.manage pelo contexto completo (revisão de segurança 13/10, item 6):
      // papel personalizado, ajuste do cargo na organização, membro desativado e 2FA — antes decidia só pelo papel.
      const ctx = await requireDisparadorAccess();
      accountId = ctx.accountId;
      callerRole = ctx.role;
      callerId = ctx.userId;

      // Iniciar enfileira até milhares de itens e aciona o cron: limite por usuário (o ramo interno do cron não passa por aqui).
      const limited = await enforceRateLimit(`disp:campaignStart:${ctx.userId}`, RATE_LIMITS.campaignStart);
      if (limited) return limited;

      // wacrm.campaigns não tem account_id (só created_by): "mesma conta" é resolvido pelo perfil do criador.
      if (campaign.created_by !== ctx.userId) {
        let sameAccountAsCreator = false;
        if (campaign.created_by) {
          const { data: creatorRows } = await ctx.supabase
            .from("profiles")
            .select("account_id")
            .eq("user_id", campaign.created_by)
            .limit(1);
          sameAccountAsCreator = (creatorRows?.[0] as { account_id?: string } | undefined)?.account_id === ctx.accountId;
        }
        if (!sameAccountAsCreator) {
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

    // skipped_known_invalid: números que a Meta já recusou como inválidos em campanha anterior e foram ignorados (omitido quando 0).
    return NextResponse.json({
      success: true,
      enqueued: result.enqueued,
      ...(result.skippedKnownInvalid ? { skipped_known_invalid: result.skippedKnownInvalid } : {}),
    });
  } catch (err) {
    console.error("[Campaign Start] Failed to schedule queue:", err);
    // 401/403 da autenticação com o code certo; o resto vira 500 genérico (sem detalhe interno).
    return toErrorResponse(err);
  }
}
