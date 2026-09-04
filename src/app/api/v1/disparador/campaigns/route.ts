import { requireApiKey } from "@/lib/auth/api-context";
import { ok, badRequest, toApiErrorResponse } from "@/lib/api/v1/respond";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { sanitizePhoneForMeta } from "@/lib/whatsapp/phone-utils";

// Payload esperado pelo sistema externo (Planejamento)
interface ExternalCampaignPayload {
  campaign_name: string;                  // obrigatório
  template_name: string;                  // obrigatório — nome do template Meta aprovado
  template_language?: string;             // padrão: "pt_BR"
  channel?: string;                       // UUID do canal OU número de telefone (ex: "+55 21 3030-9159")
  contacts: Array<{
    phone: string;                        // obrigatório — número do contato (com ou sem +)
    variables: string[];                  // variáveis posicionais {{1}}, {{2}}, {{3}}...
  }>;
  slot_size?: number;                     // qtd de contatos por slot (padrão: 1000)
  slot_interval_minutes?: number;         // intervalo entre slots em minutos (padrão: 30)
  janela_inicio?: string;                 // ex: "08:00" (padrão: "08:00")
  janela_fim?: string;                    // ex: "18:00" (padrão: "18:00")
  objective?: string;
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, "campaigns:write");
    const db = supabaseAdmin();

    const body = (await request.json().catch(() => null)) as ExternalCampaignPayload | null;

    // Validações obrigatórias
    if (!body?.campaign_name?.trim()) {
      throw badRequest("'campaign_name' é obrigatório");
    }
    if (!body?.template_name?.trim()) {
      throw badRequest("'template_name' é obrigatório");
    }
    if (!Array.isArray(body?.contacts) || body.contacts.length === 0) {
      throw badRequest("'contacts' é obrigatório e não pode ser vazio");
    }

    // Resolver canal por UUID ou número de telefone
    let channelId: string | null = null;
    if (body.channel) {
      // Tenta como UUID primeiro
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidPattern.test(body.channel)) {
        const { data: ch } = await db
          .from("whatsapp_config")
          .select("id, provider")
          .eq("id", body.channel)
          .eq("account_id", ctx.accountId)
          .eq("habilitado", true)
          .maybeSingle();
        if (ch?.provider !== "meta") {
          throw badRequest("Canal não encontrado, desabilitado ou não é Meta");
        }
        channelId = ch.id;
      } else {
        // Tenta como número de telefone — compara por dígitos apenas.
        // display_phone_number guarda o formato bruto retornado pela
        // Meta (ex: "+55 21 3030-9159", com espaços/hífen), que o
        // chamador externo não necessariamente replica byte a byte —
        // um .eq() direto no banco quase nunca daria match.
        const digitsOnly = sanitizePhoneForMeta(body.channel);
        const { data: metaChannels } = await db
          .from("whatsapp_config")
          .select("id, provider, display_phone_number")
          .eq("account_id", ctx.accountId)
          .eq("habilitado", true)
          .eq("provider", "meta");

        const match = (metaChannels ?? []).find(
          (c) =>
            c.display_phone_number &&
            sanitizePhoneForMeta(c.display_phone_number) === digitsOnly
        );
        if (!match) {
          throw badRequest(`Canal Meta não encontrado para o número: ${body.channel}`);
        }
        channelId = match.id;
      }
    } else {
      // Se não informou canal, usa o único canal Meta habilitado da conta
      const { data: channels } = await db
        .from("whatsapp_config")
        .select("id")
        .eq("account_id", ctx.accountId)
        .eq("provider", "meta")
        .eq("habilitado", true);
      if (!channels || channels.length === 0) {
        throw badRequest("Nenhum canal Meta habilitado encontrado nesta conta");
      }
      if (channels.length > 1) {
        throw badRequest("Conta com múltiplos canais Meta — informe 'channel' (UUID ou número)");
      }
      channelId = channels[0].id;
    }

    // Validar template aprovado
    const { data: templateRow } = await db
      .from("message_templates")
      .select("id, name, language")
      .eq("name", body.template_name)
      .eq("account_id", ctx.accountId)
      .eq("status", "APPROVED")
      .maybeSingle();

    if (!templateRow) {
      throw badRequest(
        `Template '${body.template_name}' não encontrado ou não aprovado pela Meta`
      );
    }

    const templateLanguage = body.template_language ?? templateRow.language ?? "pt_BR";
    const slotSize = Math.max(1, body.slot_size ?? 1000);
    const slotIntervalMs = Math.max(1, body.slot_interval_minutes ?? 30) * 60 * 1000;
    const janela_inicio = body.janela_inicio ?? "08:00";
    const janela_fim = body.janela_fim ?? "18:00";

    // Buscar blacklist
    const { data: blacklist } = await db
      .from("blacklist")
      .select("telefone");
    const blacklistSet = new Set((blacklist ?? []).map((b) => b.telefone));

    // Criar campanha
    const { data: campaign, error: campaignError } = await db
      .from("campaigns")
      .insert({
        nome: body.campaign_name,
        objetivo: body.objective ?? null,
        status: "rascunho",
        session_ids: [channelId],
        janela_inicio,
        janela_fim,
        intervalo_min: 0,
        intervalo_max: 0,
        mensagens: [
          {
            tipo: "texto",
            conteudo: `[Template: ${body.template_name}]`,
            template_name: body.template_name,
            template_language: templateLanguage,
          },
        ],
        created_by: ctx.createdBy,
      })
      .select("id")
      .single();

    if (campaignError || !campaign) {
      console.error("[v1/disparador] campaign insert error:", campaignError);
      throw badRequest("Falha ao criar campanha");
    }

    const campaignId = campaign.id;

    // Montar fila com distribuição em slots
    const queueRows: object[] = [];
    let enqueued = 0;
    let skipped = 0;
    let slotIndex = 0;

    for (let i = 0; i < body.contacts.length; i++) {
      const contact = body.contacts[i];
      if (!contact.phone) { skipped++; continue; }

      // Dígitos apenas — mesmo utilitário usado pelo restante do app
      // para enviar via Meta (sanitizePhoneForMeta), não só um replace
      // parcial de "+"/espaços.
      const normalizedPhone = sanitizePhoneForMeta(contact.phone);

      // Checar blacklist
      const phoneWithPlus = `+${normalizedPhone}`;
      if (blacklistSet.has(normalizedPhone) || blacklistSet.has(phoneWithPlus)) {
        skipped++;
        continue;
      }

      // Calcular slot
      slotIndex = Math.floor(enqueued / slotSize);
      const scheduledAt = new Date(Date.now() + slotIndex * slotIntervalMs).toISOString();

      queueRows.push({
        campaign_id: campaignId,
        contact_id: null,           // contato externo — não existe no CRM
        session_id: channelId,
        // Armazena o telefone em mensagem_final como fallback para
        // o worker resolver o destinatário (contact_id é null)
        mensagem_final: normalizedPhone,
        status: "agendado",
        tipo: "texto",
        media_url: null,
        scheduled_at: scheduledAt,
        template_name: body.template_name,
        template_language: templateLanguage,
        template_variables: Array.isArray(contact.variables) ? contact.variables : [],
      });

      enqueued++;
    }

    // Inserir fila em chunks de 500
    if (queueRows.length > 0) {
      const chunkSize = 500;
      for (let k = 0; k < queueRows.length; k += chunkSize) {
        const chunk = queueRows.slice(k, k + chunkSize);
        const { error: insertError } = await db
          .from("disp_message_queue")
          .insert(chunk);
        if (insertError) throw insertError;
      }
    }

    // Atualizar campanha para em_execucao
    await db
      .from("campaigns")
      .update({ status: "em_execucao", agendamento: new Date().toISOString() })
      .eq("id", campaignId);

    // Métricas iniciais
    await db
      .from("campaign_metrics")
      .upsert(
        { campaign_id: campaignId, total_contatos: enqueued },
        { onConflict: "campaign_id" }
      );

    const totalSlots = Math.ceil(enqueued / slotSize);
    const estimatedMinutes = (totalSlots - 1) * (body.slot_interval_minutes ?? 30);

    return ok({
      campaign_id: campaignId,
      enqueued,
      skipped,
      slots: totalSlots,
      slot_size: slotSize,
      slot_interval_minutes: body.slot_interval_minutes ?? 30,
      estimated_completion_minutes: estimatedMinutes,
    }, 201);

  } catch (err) {
    return toApiErrorResponse(err);
  }
}
