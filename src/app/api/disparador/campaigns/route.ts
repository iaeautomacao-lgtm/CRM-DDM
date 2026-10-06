import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { getDisparadorScope } from "@/lib/disparador/scope";
import { checkCampaignConfig } from "@/lib/disparador/campaign-config-check";

const ALLOWED_AUDIENCE_MODES = new Set(["csv", "tags", "account"]);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function numberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export async function POST(request: Request) {
  try {
    const supabase = await createServerClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
    }

    const { accountId } = await getDisparadorScope(supabase);
    const body = await request.json();

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
    }

    const nome = typeof body.nome === "string" ? body.nome.trim() : "";
    const sessionIds = Array.isArray(body.session_ids) ? body.session_ids.filter((v: unknown): v is string => typeof v === "string") : [];
    const mensagens = Array.isArray(body.mensagens) ? body.mensagens : [];
    if (!nome) return NextResponse.json({ error: "Insira o nome da campanha." }, { status: 400 });

    const intervaloMin = body.intervalo_min ?? 0;
    const intervaloMax = body.intervalo_max ?? 0;
    const batchSize = body.batch_size ?? 1;
    const batchPauseSeconds = body.batch_pause_seconds ?? 0;
    const batchPercent = body.batch_percent ?? null;

    if (!numberInRange(intervaloMin, 0, 86400) || !numberInRange(intervaloMax, 0, 86400) || intervaloMin > intervaloMax) {
      return NextResponse.json({ error: "Intervalo de envio inválido." }, { status: 400 });
    }
    if (!numberInRange(batchSize, 1, 999999) || !Number.isInteger(batchSize)) {
      return NextResponse.json({ error: "Tamanho de lote inválido." }, { status: 400 });
    }
    if (!numberInRange(batchPauseSeconds, 0, 604800) || !Number.isInteger(batchPauseSeconds)) {
      return NextResponse.json({ error: "Pausa entre lotes inválida." }, { status: 400 });
    }
    if (batchPercent !== null && !numberInRange(batchPercent, 1, 100)) {
      return NextResponse.json({ error: "Percentual do modo segmentado inválido." }, { status: 400 });
    }

    const janelaInicio = typeof body.janela_inicio === "string" ? body.janela_inicio : "08:00";
    const janelaFim = typeof body.janela_fim === "string" ? body.janela_fim : "18:00";
    if (!TIME_RE.test(janelaInicio) || !TIME_RE.test(janelaFim)) {
      return NextResponse.json({ error: "Janela de envio inválida." }, { status: 400 });
    }

    const agendamento =
      typeof body.agendamento === "string" && body.agendamento.trim() ? body.agendamento : null;
    if (agendamento && Number.isNaN(Date.parse(agendamento))) {
      return NextResponse.json({ error: "Agendamento inválido." }, { status: 400 });
    }

    const audienceMode = ALLOWED_AUDIENCE_MODES.has(body.audience_mode) ? body.audience_mode : "account";

    for (const msg of mensagens as any[]) {
      if (!Array.isArray(msg?.template_variable_map)) continue;
      const empty = msg.template_variable_map.findIndex(
        (v: any) => v?.type === "static" && !v?.value?.trim()
      );
      if (empty !== -1) {
        return NextResponse.json(
          { error: `Variável {{${empty + 1}}} do template está vazia.` },
          { status: 400 }
        );
      }
    }

    const configCheck = await checkCampaignConfig(
      supabaseAdmin(),
      accountId,
      sessionIds,
      mensagens
    );
    if (!configCheck.ok) {
      return NextResponse.json({ error: configCheck.error }, { status: configCheck.status });
    }

    const insert = {
      nome,
      descricao: typeof body.descricao === "string" ? body.descricao : "",
      session_ids: sessionIds,
      tags_filtro: Array.isArray(body.tags_filtro) ? body.tags_filtro : [],
      mensagens,
      intervalo_min: intervaloMin,
      intervalo_max: intervaloMax,
      janela_inicio: janelaInicio,
      janela_fim: janelaFim,
      ...(Array.isArray(body.dias_envio) && body.dias_envio.length > 0
        ? { dias_envio: body.dias_envio }
        : {}),
      batch_size: batchSize,
      batch_pause_seconds: batchPauseSeconds,
      batch_percent: batchPercent,
      dias_permitidos: body.dias_permitidos ?? "sequencia",
      agendamento,
      webchat_enabled: body.webchat_enabled === true,
      webchat_flow_id: typeof body.webchat_flow_id === "string" ? body.webchat_flow_id : null,
      webchat_message: typeof body.webchat_message === "string" ? body.webchat_message : "",
      webchat_button_text: typeof body.webchat_button_text === "string" ? body.webchat_button_text : "",
      status: agendamento ? "agendado" : "rascunho",
      audience_mode: audienceMode,
      created_by: user.id,
      account_id: accountId,
      import_draft_id: typeof body.import_draft_id === "string" ? body.import_draft_id : null,
    };

    const { data: campaign, error } = await supabaseAdmin()
      .from("campaigns")
      .insert(insert)
      .select("id")
      .single();
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, id: campaign.id }, { status: 201 });
  } catch (err: unknown) {
    console.error("[Campaign Create] Failed:", err);
    const message = err instanceof Error ? err.message : "Erro desconhecido";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
