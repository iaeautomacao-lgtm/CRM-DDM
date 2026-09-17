import { supabaseAdmin } from "@/lib/disparador/admin-client";

export type StartCampaignResult =
  | { ok: true; enqueued: number }
  | { ok: false; status: number; error: string };

// Extraído de src/app/api/disparador/campaigns/[id]/start/route.ts —
// idêntico ao corpo de negócio daquela rota (steps 1-5), só que
// parametrizado por (campaignId, accountId) em vez de depender de
// Request/sessão, para que o cron possa iniciar campanhas agendadas
// direto via supabaseAdmin(), sem round-trip HTTP pro endpoint /start
// (eliminando a necessidade do header x-internal-cron).
//
// A resolução de accountId (via sessão de usuário ou via
// created_by -> profiles.account_id no caso do cron) e qualquer checagem
// de ownership continuam responsabilidade do chamador — esta função só
// enfileira, assumindo que accountId já é confiável.
export async function startCampaign(
  campaignId: string,
  accountId: string
): Promise<StartCampaignResult> {
  try {
    // 1. Fetch Campaign configuration
    const { data: campaign, error: campaignError } = await supabaseAdmin()
      .from("campaigns")
      .select("*")
      .eq("id", campaignId)
      .single();

    if (campaignError || !campaign) {
      return { ok: false, status: 404, error: "Campanha não encontrada" };
    }

    // Only "rascunho" (never started), "pausada" (resuming) and
    // "agendado" (scheduled start time reached, cron-triggered) are
    // valid starting points — see STATUS_LABELS in campanhas/page.tsx.
    // Enforced here, not just disabled in the UI, so a direct call to
    // this route can't re-run a campaign that's already sending or
    // restart one that's already closed.
    const STARTABLE_STATUSES = ["rascunho", "pausada", "agendado"];
    if (!STARTABLE_STATUSES.includes(campaign.status)) {
      return {
        ok: false,
        status: 409,
        error:
          campaign.status === "em_execucao"
            ? "Esta campanha já está em execução."
            : "Esta campanha está encerrada e não pode ser reiniciada.",
      };
    }

    const mensagens = Array.isArray(campaign.mensagens) ? campaign.mensagens : [];
    if (mensagens.length === 0) {
      return { ok: false, status: 400, error: "Campanha sem mensagens configuradas." };
    }

    const sessionIds = Array.isArray(campaign.session_ids) ? campaign.session_ids : [];
    if (sessionIds.length === 0) {
      return { ok: false, status: 400, error: "Campanha sem sessões de WhatsApp selecionadas." };
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
      return { ok: false, status: 400, error: "Nenhum contato ativo encontrado no CRM." };
    }

    // Load contact tags relation — escopada pelos contact_ids desta conta,
    // em chunks de 500. contact_tags não tem account_id, então uma query
    // sem filtro nem paginação retorna no máximo db-max-rows linhas do
    // BANCO INTEIRO (confirmado ao vivo: 1093 linhas totais no banco,
    // cap silencioso do PostgREST em 1000) — contatos desta conta podiam
    // ficar de fora aleatoriamente do enfileiramento sem gerar erro.
    const contactIds = allContacts.map((c) => c.id);
    const tagsChunkSize = 500;
    const allTagRows: { contact_id: string; tags: unknown }[] = [];

    for (let i = 0; i < contactIds.length; i += tagsChunkSize) {
      const chunk = contactIds.slice(i, i + tagsChunkSize);
      const { data: tagRows, error: tagRowsError } = await supabaseAdmin()
        .from("contact_tags")
        .select("contact_id, tags:tag_id(name)")
        .in("contact_id", chunk);

      if (tagRowsError) {
        throw new Error(`Erro ao carregar tags dos contatos: ${tagRowsError.message}`);
      }
      if (tagRows) allTagRows.push(...tagRows);
    }

    const tagsMap: Record<string, string[]> = {};
    for (const item of allTagRows) {
      if (!item.contact_id) continue;
      const tagName = (item.tags as any)?.name;
      if (tagName) {
        if (!tagsMap[item.contact_id]) {
          tagsMap[item.contact_id] = [];
        }
        tagsMap[item.contact_id].push(tagName);
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
      return {
        ok: false,
        status: 400,
        error: "Nenhum contato encontrado com as tags de filtro selecionadas.",
      };
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
        console.error("[startCampaign] Falha ao carregar disparador_utm_links:", err);
      }
    }

    // VAR1/VAR2/VAR3 do CSV por contato (contact_id + var_index -> value),
    // persistidas no import em wacrm.contact_import_variables (migration
    // 079). Só consulta se alguma mensagem usa `{ type: "csv_var" }` —
    // mesmo padrão do usaUtmLink acima.
    const usaCsvVar = mensagens.some(
      (m: any) =>
        Array.isArray(m.template_variable_map) &&
        m.template_variable_map.some((e: any) => e?.type === "csv_var")
    );
    const csvVarMap = new Map<string, string>();
    if (usaCsvVar) {
      const { data: csvVars, error: csvVarsError } = await supabaseAdmin()
        .from("contact_import_variables")
        .select("contact_id, var_index, value")
        .eq("campaign_id", campaignId);
      if (csvVarsError) {
        console.error("[startCampaign] Falha ao carregar contact_import_variables:", csvVarsError);
      } else {
        for (const row of csvVars ?? []) {
          csvVarMap.set(`${row.contact_id}:${row.var_index}`, row.value);
        }
      }
    }

    // 4. Scheduling queue generation loop
    const minDelay = (campaign.intervalo_min || 90) * 1000;
    const maxDelay = (campaign.intervalo_max || 300) * 1000;
    const intraDelay = 3000; // 3 seconds between messages for the same contact

    // Se a campanha tem agendamento futuro, usa como base do scheduled_at
    // (ex: start manual antecipado de uma campanha "agendado"). Senão usa
    // Date.now() — inclui o caso normal em que o cron só chama start
    // depois que agendamento já passou, onde essa condição é sempre falsa.
    const now = new Date().toISOString();
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
        // placeholders are resolved at send time (processQueueItem) via
        // applyTemplateVars, not here, so they reflect the contact's
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
            if (entry?.type === "csv_var") {
              // Vazio se este contato não tiver essa coluna preenchida no
              // CSV importado (ou se o import não tiver rodado com esta
              // campanha/rascunho associado) — mesma degradação dos casos
              // acima em vez de derrubar o enfileiramento inteiro.
              return csvVarMap.get(`${contact.id}:${entry.index}`) ?? "";
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

    return { ok: true, enqueued };
  } catch (err: any) {
    console.error("[startCampaign] Failed to schedule queue:", err);
    return { ok: false, status: 500, error: err.message };
  }
}
