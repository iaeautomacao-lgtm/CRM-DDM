import { NextResponse } from "next/server";
import { toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { requireDisparadorAccess } from "@/lib/disparador/route-auth";
import { checkCampaignConfig } from "@/lib/disparador/campaign-config-check";
import {
  decideCampaignStatus,
  parseTemplateMode,
  validateCampaignSettings,
} from "@/lib/disparador/campaign-validation";
import {
  CAMPAIGN_WRITABLE_FIELDS,
  isMissingColumnError,
  normalizeHHMM,
  pickCampaignFields,
} from "@/lib/disparador/campaign-payload";
import { syncCampaignPlannedMetrics } from "@/lib/disparador/campaign-planning";

// Status em que a campanha ainda pode ser editada: a fila não existe. Em
// "agendado" a edição é permitida (antes só "rascunho"): o cron só monta a
// fila quando o agendamento vence, e o UPDATE abaixo é condicionado ao
// status — se o cron começar no meio, a edição é recusada (409).
const EDITABLE_STATUSES = ["rascunho", "agendado"] as const;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Sessão + conta + papel (owner/admin, mesmo da página /disparador).
  let accountId: string;
  try {
    ({ accountId } = await requireDisparadorAccess());
  } catch (err) {
    return toErrorResponse(err);
  }
  try {
    const { id: campaignId } = await params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Corpo da requisição inválido." }, { status: 400 });
    }

    const { data: rows, error: campaignError } = await supabaseAdmin()
      .from("campaigns")
      .select("*")
      .eq("id", campaignId)
      .limit(1);
    const campaign = rows?.[0] as Record<string, unknown> | undefined;

    if (campaignError || !campaign) {
      return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
    }

    if (!campaign.account_id || campaign.account_id !== accountId) {
      return NextResponse.json(
        { error: "Você não tem permissão para editar esta campanha." },
        { status: 403 }
      );
    }

    // Depois que a fila existe (preparando/em_execucao/pausada/encerrada),
    // mudar mensagens ou canais aqui dessincronizaria do que já foi
    // agendado/enviado. Rechecado aqui: a trava da tela pode ser contornada.
    if (!(EDITABLE_STATUSES as readonly unknown[]).includes(campaign.status)) {
      return NextResponse.json(
        { error: "Só é possível editar campanhas em rascunho ou agendadas." },
        { status: 409 }
      );
    }

    const updates: Record<string, unknown> = pickCampaignFields(body);
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "Nenhum campo para atualizar." }, { status: 400 });
    }

    // Validação sobre o estado FINAL (o que já está salvo + o que veio no
    // corpo), com as mesmas regras da criação e do início
    // (campaign-validation.ts). A janela salva numa coluna time volta com
    // segundos — normalizada antes de conferir.
    const merged: Record<string, unknown> = {};
    for (const field of CAMPAIGN_WRITABLE_FIELDS) {
      merged[field] = field in updates ? updates[field] : campaign[field];
    }
    merged.janela_inicio = normalizeHHMM(merged.janela_inicio);
    merged.janela_fim = normalizeHHMM(merged.janela_fim);
    // Rascunho não tem agendamento vivo: o valor salvo pode ser o de um
    // início que falhou (já no passado). Só conta se vier no corpo.
    if (!("agendamento" in updates) && campaign.status === "rascunho") merged.agendamento = null;

    const settingsErrors = validateCampaignSettings(merged, {
      requireAudience: "audience_mode" in updates,
      confirmAllContacts: body.confirm_all_contacts === true || campaign.audience_mode === "account",
    });
    if (settingsErrors.length > 0) {
      return NextResponse.json({ error: settingsErrors[0], errors: settingsErrors }, { status: 400 });
    }

    const check = await checkCampaignConfig(
      supabaseAdmin(),
      accountId,
      Array.isArray(merged.session_ids) ? (merged.session_ids as string[]) : [],
      Array.isArray(merged.mensagens) ? (merged.mensagens as Record<string, unknown>[]) : [],
      {
        templateMode: parseTemplateMode(merged.dias_permitidos),
        audienceMode: (merged.audience_mode as string | null | undefined) ?? null,
      }
    );
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: check.status });
    }

    // Status decidido aqui, nunca pelo cliente: agendamento → agendado.
    updates.status = decideCampaignStatus(merged.agendamento);
    // Campanha editada: o motivo da última falha de início (migration 160)
    // deixa de valer.
    updates.motivo_falha_inicio = null;

    const runUpdate = (values: Record<string, unknown>) =>
      supabaseAdmin()
        .from("campaigns")
        .update(values)
        .eq("id", campaignId)
        .in("status", [...EDITABLE_STATUSES])
        .select("id");

    let result = await runUpdate(updates);
    // Migrations 160/162 ainda não aplicadas: grava sem as colunas novas.
    for (const column of ["agendamento_fim", "motivo_falha_inicio"]) {
      if (result.error && isMissingColumnError(result.error, column)) {
        delete updates[column];
        result = await runUpdate(updates);
      }
    }

    if (result.error) {
      return NextResponse.json({ error: result.error.message }, { status: 500 });
    }
    if (!result.data || result.data.length === 0) {
      return NextResponse.json(
        { error: "A campanha começou a ser preparada enquanto você editava. Atualize a página." },
        { status: 409 }
      );
    }

    // Público, tabulações ou configuração podem ter mudado na edição.
    // Atualiza o total planejado usado no card/previsão antes do início.
    const planned = await syncCampaignPlannedMetrics(
      supabaseAdmin(),
      accountId,
      campaignId
    );
    if (!planned.ok) {
      console.warn("[Campaign Update] planned metrics:", planned.error);
    }

    return NextResponse.json({ success: true, status: updates.status });
  } catch (err: unknown) {
    console.error("[Campaign Update] Failed:", err);
    const message = err instanceof Error ? err.message : "Erro desconhecido";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let accountId: string;
  try {
    ({ accountId } = await requireDisparadorAccess());
  } catch (err) {
    return toErrorResponse(err);
  }
  try {
    const { id: campaignId } = await params;

    const { data: campaign, error: campaignError } = await supabaseAdmin()
      .from("campaigns")
      .select("id, account_id, status")
      .eq("id", campaignId)
      .single();

    if (campaignError || !campaign) {
      return NextResponse.json({ error: "Campanha não encontrada" }, { status: 404 });
    }

    if (!campaign.account_id || campaign.account_id !== accountId) {
      return NextResponse.json(
        { error: "Você não tem permissão para deletar esta campanha." },
        { status: 403 }
      );
    }

    // disp_message_queue.campaign_id is ON DELETE CASCADE, so deleting a
    // running campaign silently wipes its in-flight queue mid-send.
    // Re-checked here since the client-side check can be bypassed by
    // calling this route directly.
    if (campaign.status === "em_execucao") {
      return NextResponse.json(
        { error: "Não é possível deletar uma campanha em execução. Pause ou encerre a campanha primeiro." },
        { status: 409 }
      );
    }

    const { error: deleteError } = await supabaseAdmin()
      .from("campaigns")
      .delete()
      .eq("id", campaignId);

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    console.error("[Campaign Delete] Failed:", err);
    const message = err instanceof Error ? err.message : "Erro desconhecido";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
