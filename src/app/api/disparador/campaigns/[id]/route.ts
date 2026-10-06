import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { getDisparadorScope } from "@/lib/disparador/scope";
import { checkCampaignConfig } from "@/lib/disparador/campaign-config-check";

const EDITABLE_FIELDS = [
  "nome",
  "descricao",
  "session_ids",
  "tags_filtro",
  "mensagens",
  "intervalo_min",
  "intervalo_max",
  "janela_inicio",
  "janela_fim",
  "dias_envio",
  "agendamento",
  "batch_size",
  "batch_pause_seconds",
  // Migration 114 — modo de disparo "Segmentado".
  "batch_percent",
  // Coluna jsonb legada ("dias da semana permitidos") nunca lida por este
  // código — reaproveitada para guardar o modo de alternância de
  // templates (template_mode: "sequencia" | "rotacao" | "aleatorio") sem
  // precisar de uma migration nova. Ver parseTemplateMode em
  // campanhas/page.tsx e startCampaign.ts.
  "dias_permitidos",
  // Migration 127 — "Ao responder, enviar para o Webchat".
  // Migration 132 — origem do público ("csv" | "tags" | "account").
  "audience_mode",
  "webchat_enabled",
  "webchat_flow_id",
  "webchat_message",
  "webchat_button_text",
] as const;

export async function PATCH(
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
    const body = await request.json();

    const { accountId } = await getDisparadorScope(supabase);

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
        { error: "Você não tem permissão para editar esta campanha." },
        { status: 403 }
      );
    }

    // Editing is only allowed while the campaign hasn't been started yet —
    // once queue items exist (em_execucao/pausada/encerrada), changing the
    // message set or session list here would desync from what's already
    // scheduled/sent. Re-checked here since the client-side lock (the edit
    // button only shows for "rascunho") can be bypassed by calling this
    // route directly.
    if (campaign.status !== "rascunho") {
      return NextResponse.json(
        { error: "Só é possível editar campanhas em rascunho." },
        { status: 409 }
      );
    }

    const updates: Record<string, unknown> = {};
    for (const field of EDITABLE_FIELDS) {
      if (field in body) updates[field] = body[field];
    }

    // Editar o agendamento também move o status entre rascunho/agendado —
    // este endpoint só edita campanhas em "rascunho" (guard acima), então
    // isso nunca sai de "agendado"/"em_execucao"/etc, só entra ou sai de
    // "agendado" a partir de "rascunho".
    if ("agendamento" in updates) {
      updates.status = updates.agendamento ? "agendado" : "rascunho";
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "Nenhum campo para atualizar." }, { status: 400 });
    }

    // template_variable_map com static.value vazio dispara erro #131008 na
    // Meta no momento do envio real — bloqueia aqui, não só no wizard, já
    // que esta rota pode ser chamada direto (client-side validation em
    // campanhas/page.tsx pode ser contornada).
    if (Array.isArray(updates.mensagens)) {
      for (const msg of updates.mensagens as any[]) {
        if (!Array.isArray(msg?.template_variable_map)) continue;
        const variavelVazia = msg.template_variable_map.findIndex(
          (v: any) => v?.type === "static" && !v?.value?.trim()
        );
        if (variavelVazia !== -1) {
          return NextResponse.json(
            {
              error: `Variável {{${variavelVazia + 1}}} do template está vazia. Preencha um valor fixo ou mude para "Campo do contato".`,
            },
            { status: 400 }
          );
        }
      }
    }

    // Canais + mensagens (campaign-validation.ts — mesma regra do
    // startCampaign e do assistente): canais da conta e habilitados, sem
    // misturar Meta e WAHA, Meta = uma WABA e só templates aprovados do
    // catálogo dessa WABA. Validado sobre o estado final (o que veio no
    // corpo + o que já está salvo).
    if ("session_ids" in updates || "mensagens" in updates) {
      const { data: currentRows, error: currentError } = await supabaseAdmin()
        .from("campaigns")
        .select("session_ids, mensagens")
        .eq("id", campaignId)
        .limit(1);
      if (currentError) {
        return NextResponse.json({ error: currentError.message }, { status: 500 });
      }
      const current = currentRows?.[0] ?? {};
      const sessionIds = "session_ids" in updates ? updates.session_ids : current.session_ids;
      const mensagens = "mensagens" in updates ? updates.mensagens : current.mensagens;
      const check = await checkCampaignConfig(
        supabaseAdmin(),
        accountId,
        Array.isArray(sessionIds) ? sessionIds : [],
        Array.isArray(mensagens) ? mensagens : []
      );
      if (!check.ok) {
        return NextResponse.json({ error: check.error }, { status: check.status });
      }
    }

    const { error: updateError } = await supabaseAdmin()
      .from("campaigns")
      .update(updates)
      .eq("id", campaignId);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // Campanha editada: o motivo da última falha de início (migration 160)
    // deixa de valer. UPDATE separado e tolerante à coluna ausente.
    const { error: motivoError } = await supabaseAdmin()
      .from("campaigns")
      .update({ motivo_falha_inicio: null })
      .eq("id", campaignId)
      .not("motivo_falha_inicio", "is", null);
    if (motivoError) console.error("[Campaign Update] motivo_falha_inicio:", motivoError.message);

    return NextResponse.json({ success: true });
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

    const { accountId } = await getDisparadorScope(supabase);

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
