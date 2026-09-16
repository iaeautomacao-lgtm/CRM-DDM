import { NextResponse } from "next/server";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { ensureQueueWorkerRunning } from "@/lib/disparador/worker";

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

    // 1. Fetch Campaign configuration (buscado uma única vez, antes de
    // ramificar a autenticação — a chamada interna do cron também
    // precisa desta linha pra resolver created_by/account_id).
    const { data: campaign, error: campaignError } = await supabaseAdmin()
      .from("campaigns")
      .select("*")
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
    const now = new Date().toISOString();

    // Only "rascunho" (never started), "pausada" (resuming) and
    // "agendado" (scheduled start time reached, cron-triggered) are
    // valid starting points — see STATUS_LABELS in campanhas/page.tsx.
    // Enforced here, not just disabled in the UI, so a direct call to
    // this route can't re-run a campaign that's already sending or
    // restart one that's already closed.
    const STARTABLE_STATUSES = ["rascunho", "pausada", "agendado"];
    if (!STARTABLE_STATUSES.includes(campaign.status)) {
      return NextResponse.json(
        {
          error:
            campaign.status === "em_execucao"
              ? "Esta campanha já está em execução."
              : "Esta campanha está encerrada e não pode ser reiniciada.",
        },
        { status: 409 }
      );
    }

    const mensagens = Array.isArray(campaign.mensagens) ? campaign.mensagens : [];
    if (mensagens.length === 0) {
      return NextResponse.json(
        { error: "Campanha sem mensagens configuradas." },
        { status: 400 }
      );
    }

    const sessionIds = Array.isArray(campaign.session_ids) ? campaign.session_ids : [];
    if (sessionIds.length === 0) {
      return NextResponse.json(
        { error: "Campanha sem sessões de WhatsApp selecionadas." },
        { status: 400 }
      );
    }

    // Buscar provider de cada canal selecionado na campanha
    const { data: channelConfigs } = await supabaseAdmin()
      .from("whatsapp_config")
      .select("id, provider, phone_number_id")
      .in("id", sessionIds);

    const channelMap = new Map(
      (channelConfigs ?? []).map((c) => [c.id, c])
    );

    // IDs dos canais Meta nesta campanha
    const metaSessionIds = (channelConfigs ?? [])
      .filter((c) => c.provider === "meta")
      .map((c) => c.id);

    // windowMap: contact_id → Date do último inbound via canal Meta
    // Usado para decidir template vs texto livre no loop de enfileiramento
    const windowMap = new Map<string, Date>();

    if (metaSessionIds.length > 0) {
      const { data: lastInbounds } = await supabaseAdmin()
        .schema("wacrm")
        .from("messages")
        .select("received_at, conversations!inner(contact_id, config_id)")
        .eq("sender_type", "contact")
        .in("conversations.config_id", metaSessionIds)
        .order("received_at", { ascending: false });

      for (const row of lastInbounds ?? []) {
        const conv = row.conversations as unknown as {
          contact_id: string;
          config_id: string;
        };
        if (conv?.contact_id && !windowMap.has(conv.contact_id)) {
          windowMap.set(conv.contact_id, new Date(row.received_at));
        }
      }
    }

    // 2. Remove previously scheduled/pending items to prevent duplication.
    // 'enviando' incluído para limpar itens travados por crash/deploy
    // anterior (processo derrubado entre o claim e o update final).
    await supabaseAdmin()
      .from("disp_message_queue")
      .delete()
      .eq("campaign_id", campaignId)
      .in("status", ["pendente", "agendado", "erro", "enviando"]);

    // 3. Load active contacts — scoped to the caller's account so a
    // campaign never sends to another account's contacts.
    const { data: allContacts, error: contactsError } = await supabaseAdmin()
      .from("contacts")
      .select("id, name, phone, company, phone_normalized")
      .eq("account_id", accountId);

    if (contactsError) {
      throw new Error(`Erro ao carregar contatos: ${contactsError.message}`);
    }

    if (!allContacts || allContacts.length === 0) {
      return NextResponse.json(
        { error: "Nenhum contato ativo encontrado no CRM." },
        { status: 400 }
      );
    }

    // Load contact tags relation
    const { data: tagsList } = await supabaseAdmin()
      .from("contact_tags")
      .select("contact_id, tags:tag_id(name)");

    const tagsMap: Record<string, string[]> = {};
    if (tagsList) {
      for (const item of tagsList) {
        if (!item.contact_id) continue;
        const tagName = (item.tags as any)?.name;
        if (tagName) {
          if (!tagsMap[item.contact_id]) {
            tagsMap[item.contact_id] = [];
          }
          tagsMap[item.contact_id].push(tagName);
        }
      }
    }

    // Map tags to contacts in memory
    const contactsWithTags = allContacts.map((c) => ({
      ...c,
      tags: tagsMap[c.id] || [],
    }));

    // Filter contacts by tag
    const tagsFiltro = Array.isArray(campaign.tags_filtro) ? campaign.tags_filtro : [];
    const contacts = tagsFiltro.length > 0
      ? contactsWithTags.filter((c) => {
          const contactTags = Array.isArray(c.tags) ? c.tags : [];
          return tagsFiltro.some((t: string) => contactTags.includes(t));
        })
      : contactsWithTags;

    if (contacts.length === 0) {
      return NextResponse.json(
        { error: "Nenhum contato encontrado com as tags de filtro selecionadas." },
        { status: 400 }
      );
    }

    // Fetch Blacklist to skip
    const { data: blacklist } = await supabaseAdmin().from("blacklist").select("telefone");
    const blacklistSet = new Set((blacklist ?? []).map((b) => b.telefone));

    // Links UTM personalizados por contato (telefone normalizado -> link),
    // gerados em campanhas/page.tsx via handleGerarUTM e persistidos em
    // wacrm.disparador_utm_links (migration 076). Só consulta se alguma
    // mensagem realmente usa `{ type: "utm_link" }` no template_variable_map
    // — evita a query em campanhas sem esse recurso. Tolerante à migration
    // não aplicada: erro aqui não derruba o início da campanha, só faz o
    // {{n}} correspondente sair vazio (ver resolução abaixo).
    const usaUtmLink = mensagens.some(
      (m: any) =>
        Array.isArray(m.template_variable_map) &&
        m.template_variable_map.some((e: any) => e?.type === "utm_link")
    );
    const utmLinkByPhone = new Map<string, string>();
    if (usaUtmLink) {
      try {
        const { data: utmLinks, error: utmLinksError } = await supabaseAdmin()
          .from("disparador_utm_links")
          .select("phone_normalized, link_curto")
          .eq("campaign_id", campaignId);
        if (utmLinksError) throw utmLinksError;
        for (const row of utmLinks ?? []) {
          if (row.phone_normalized) utmLinkByPhone.set(row.phone_normalized, row.link_curto);
        }
      } catch (err) {
        console.error("[Campaign Start] Falha ao carregar disparador_utm_links:", err);
      }
    }

    // 4. Scheduling queue generation loop
    const minDelay = (campaign.intervalo_min || 90) * 1000;
    const maxDelay = (campaign.intervalo_max || 300) * 1000;
    const intraDelay = 3000; // 3 seconds between messages for the same contact

    // Se a campanha tem agendamento futuro, usa como base do scheduled_at
    // (ex: start manual antecipado de uma campanha "agendado"). Senão usa
    // Date.now() — inclui o caso normal em que o cron só chama /start
    // depois que agendamento já passou, onde essa condição é sempre falsa.
    const baseTime =
      campaign.agendamento && new Date(campaign.agendamento) > new Date()
        ? new Date(campaign.agendamento).getTime()
        : Date.now();

    let contactDelay = 0;
    let enqueued = 0;
    const queueRows = [];

    for (let i = 0; i < contacts.length; i++) {
      const contact = contacts[i];

      // Skip if phone is blacklisted
      if (contact.phone && blacklistSet.has(contact.phone)) continue;

      // Select random session ID from campaign configurations
      const sessionId = sessionIds[Math.floor(Math.random() * sessionIds.length)];

      // Anti-spam pauses
      if (i > 0 && i % 100 === 0) contactDelay += 60 * 60 * 1000; // 1 hour pause every 100 contacts
      else if (i > 0 && i % 20 === 0) contactDelay += 10 * 60 * 1000; // 10 mins pause every 20 contacts

      const channel = channelMap.get(sessionId);
      const isMetaChannel = channel?.provider === "meta";

      for (let j = 0; j < mensagens.length; j++) {
        const msg = mensagens[j];
        const msgDelay = contactDelay + j * intraDelay;
        const scheduledAt = new Date(baseTime + msgDelay).toISOString();

        // Store the raw template text — {{variavel}} and legacy {nome}
        // placeholders are resolved at send time (worker.ts / cron/route.ts)
        // via applyTemplateVars, not here, so they reflect the contact's
        // current data and today's date rather than a snapshot from enqueue.
        const rawText = msg.conteudo || msg.prompt || "";

        // Meta template fields — resolved per-contact from template_variable_map
        // (populated in campanhas/page.tsx only when the message came from the
        // Meta template catalog). Null for WAHA / non-template messages.
        let templateName: string | null = null;
        let templateLanguage: string | null = null;
        let templateVariables: string[] | null = null;

        if (msg.template_name && Array.isArray(msg.template_variable_map)) {
          templateName = msg.template_name;
          templateLanguage = msg.template_language || "pt_BR";
          templateVariables = msg.template_variable_map.map((entry: any) => {
            if (entry?.type === "contact_field") {
              return String((contact as any)[entry.field] ?? "");
            }
            if (entry?.type === "utm_link") {
              // Vazio se este contato não tiver link gerado (CSV sem CPF,
              // geração de UTM pulada, etc.) — degrada para {{n}} vazio em
              // vez de derrubar o enfileiramento da campanha inteira.
              return utmLinkByPhone.get((contact as any).phone_normalized) ?? "";
            }
            return String(entry?.value ?? "");
          });
        }

        // Validação de janela 24h para canais Meta sem template
        if (isMetaChannel && !templateName) {
          const lastInbound = windowMap.get(contact.id);
          const windowOpen =
            lastInbound != null &&
            Date.now() - lastInbound.getTime() < 24 * 60 * 60 * 1000;

          if (!windowOpen) {
            // Contato fora da janela e sem template — enfileira como
            // erro imediato em vez de tentar enviar (a Meta rejeitaria
            // com 131026). Conta para métricas e aparece na UI.
            queueRows.push({
              campaign_id: campaignId,
              contact_id: contact.id,
              session_id: sessionId,
              mensagem_final: rawText,
              status: "erro",
              erro: "Janela de 24h encerrada — use um template aprovado para este contato",
              tipo: msg.tipo || "texto",
              media_url: msg.url || null,
              scheduled_at: scheduledAt,
              template_name: null,
              template_language: null,
              template_variables: null,
            });
            enqueued++;
            continue;
          }
        }

        queueRows.push({
          campaign_id: campaignId,
          contact_id: contact.id,
          session_id: sessionId,
          mensagem_final: rawText,
          status: "agendado",
          tipo: msg.tipo || "texto",
          media_url: msg.url || null,
          scheduled_at: scheduledAt,
          template_name: templateName,
          template_language: templateLanguage,
          template_variables: templateVariables,
        });
        enqueued++;
      }

      // Increment delay for the next contact
      contactDelay += (mensagens.length - 1) * intraDelay + minDelay + Math.random() * (maxDelay - minDelay);
    }

    if (queueRows.length > 0) {
      // Chunk insertions to prevent Supabase payload size limits (e.g. 500 items per chunk)
      const chunkSize = 500;
      for (let k = 0; k < queueRows.length; k += chunkSize) {
        const chunk = queueRows.slice(k, k + chunkSize);
        const { error: insertError } = await supabaseAdmin()
          .from("disp_message_queue")
          .insert(chunk);
        if (insertError) throw insertError;
      }
    }

    // 5. Update campaign status to 'em_execucao' (In execution)
    await supabaseAdmin()
      .from("campaigns")
      .update({ status: "em_execucao", agendamento: now })
      .eq("id", campaignId);

    // Update Metrics
    await supabaseAdmin()
      .from("campaign_metrics")
      .upsert({
        campaign_id: campaignId,
        total_contatos: contacts.length,
      }, { onConflict: "campaign_id" });

    return NextResponse.json({ success: true, enqueued });
  } catch (err: any) {
    console.error("[Campaign Start] Failed to schedule queue:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
