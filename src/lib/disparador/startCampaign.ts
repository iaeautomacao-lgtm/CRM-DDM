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

    // Retomada de campanha pausada — caminho separado do enfileiramento
    // do zero abaixo. Os itens que /stop?action=pause deixou com
    // status='pausado' (ver stop/route.ts) ficavam órfãos: o worker só
    // reivindica status='agendado' (claimQueueItem), e o passo de limpeza
    // logo abaixo não deleta 'pausado', então reenfileirar do zero criava
    // um segundo lote inteiro para todos os contatos em vez de continuar
    // de onde parou. Reativa os itens pausados in-place e retorna sem
    // tocar em mensagens/contatos/fila nova.
    if (campaign.status === "pausada") {
      const { data: reactivated, error: reactivateError } = await supabaseAdmin()
        .from("disp_message_queue")
        .update({ status: "agendado", scheduled_at: new Date().toISOString() })
        .eq("campaign_id", campaignId)
        .eq("status", "pausado")
        .select("id");

      if (reactivateError) {
        return { ok: false, status: 500, error: reactivateError.message };
      }

      await supabaseAdmin()
        .from("campaigns")
        .update({ status: "em_execucao" })
        .eq("id", campaignId);

      return { ok: true, enqueued: reactivated?.length ?? 0 };
    }

    const mensagens = Array.isArray(campaign.mensagens) ? campaign.mensagens : [];
    if (mensagens.length === 0) {
      return { ok: false, status: 400, error: "Campanha sem mensagens configuradas." };
    }

    const sessionIds = Array.isArray(campaign.session_ids) ? campaign.session_ids : [];
    if (sessionIds.length === 0) {
      return { ok: false, status: 400, error: "Campanha sem sessões de WhatsApp selecionadas." };
    }

    // Relink de segurança: VAR1/VAR2/VAR3 do CSV (Step 2 do wizard) podem
    // ter sido salvas sob campaign.import_draft_id (migration 080) sem
    // nunca terem sido reatribuídas ao campaign_id real — o relink
    // client-side em campanhas/page.tsx é best-effort e pode falhar
    // silenciosamente (ex: duplo-submit, RLS). Roda ANTES da leitura de
    // csvVarMap abaixo, que é o ponto onde os valores (vazios ou não)
    // ficam congelados em disp_message_queue — depois disso é tarde
    // demais. Usa import_draft_id (gravado na própria campanha), não uma
    // busca por "draft mais recente da conta": múltiplos rascunhos/
    // campanhas podem ter linhas órfãs ao mesmo tempo, e vincular pelo
    // mais recente arriscaria trazer variáveis de OUTRO CSV/campanha.
    if (campaign.import_draft_id) {
      const { error: csvVarRelinkErr } = await supabaseAdmin()
        .from("contact_import_variables")
        .update({ campaign_id: campaignId })
        .eq("draft_id", campaign.import_draft_id)
        .is("campaign_id", null);
      if (csvVarRelinkErr) {
        console.error("[startCampaign] Falha ao relinkar contact_import_variables:", csvVarRelinkErr);
      }
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
        // 'contact' nunca existe em wacrm.messages.sender_type (valores reais:
        // 'customer'/'agent'/'bot', confirmado ao vivo) — com 'contact', esta
        // query sempre voltava vazia, então windowMap ficava sempre vazio e
        // todo envio Meta sem template caía permanentemente no ramo "fora da
        // janela de 24h" (erro 131026), mesmo pra contatos que responderam há
        // minutos.
        .eq("sender_type", "customer")
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
    // campaign never sends to another account's contacts. Paginado via
    // .range() — mesmo padrão do filtro por tag abaixo (contact_tags) —
    // sem isso, o cap de resposta do PostgREST (1000 linhas) trunca
    // contas com mais de 1000 contatos silenciosamente.
    const allContacts: any[] = [];
    {
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data: page, error: pageError } = await supabaseAdmin()
          .from("contacts")
          .select("id, name, phone, company, phone_normalized")
          .eq("account_id", accountId)
          .range(from, from + pageSize - 1);

        if (pageError) {
          throw new Error(`Erro ao carregar contatos: ${pageError.message}`);
        }
        allContacts.push(...(page ?? []));
        if (!page || page.length < pageSize) break;
        from += pageSize;
      }
    }

    if (allContacts.length === 0) {
      return { ok: false, status: 400, error: "Nenhum contato ativo encontrado no CRM." };
    }

    // Filter contacts by tag — filtra pelo lado pequeno (nomes em
    // tags_filtro, tipicamente 1-5) em vez de carregar contact_tags de
    // TODOS os contatos da conta (que já foi tentado em duas voltas
    // anteriores e falhou nas duas):
    //   1) sem filtro nenhum: contact_tags não tem account_id, então a
    //      query batia no cap de resposta do PostgREST (db-max-rows,
    //      confirmado ao vivo em 1000) e truncava silenciosamente — sem
    //      erro, só menos contatos enfileirados que o esperado.
    //   2) com .in('contact_id', chunk) em chunks de 500: corrigia o
    //      truncamento mas um array de centenas de UUIDs num filtro GET
    //      gera uma URL de dezenas de KB, o que bateu em algum limite de
    //      tamanho de URL da infra em produção ("TypeError: fetch failed").
    // Filtrar por tag_id (poucos valores) e paginar a RESPOSTA com
    // .range() resolve os dois problemas ao mesmo tempo: o filtro de
    // entrada nunca é grande, e a paginação explícita nunca depende do
    // cap implícito do PostgREST pra trazer tudo.
    const tagsFiltro = Array.isArray(campaign.tags_filtro) ? campaign.tags_filtro : [];
    let contacts = allContacts;

    if (tagsFiltro.length > 0) {
      const { data: matchingTags, error: matchingTagsError } = await supabaseAdmin()
        .from("tags")
        .select("id")
        .eq("account_id", accountId)
        .in("name", tagsFiltro);

      if (matchingTagsError) {
        throw new Error(`Erro ao resolver tags de filtro: ${matchingTagsError.message}`);
      }

      const tagIds = (matchingTags ?? []).map((t) => t.id);
      const matchingContactIds = new Set<string>();

      if (tagIds.length > 0) {
        const pageSize = 1000;
        let from = 0;
        while (true) {
          const { data: page, error: pageError } = await supabaseAdmin()
            .from("contact_tags")
            .select("contact_id")
            .in("tag_id", tagIds)
            .range(from, from + pageSize - 1);

          if (pageError) {
            throw new Error(`Erro ao carregar tags dos contatos: ${pageError.message}`);
          }
          for (const row of page ?? []) {
            if (row.contact_id) matchingContactIds.add(row.contact_id);
          }
          if (!page || page.length < pageSize) break;
          from += pageSize;
        }
      }

      contacts = allContacts.filter((c) => matchingContactIds.has(c.id));
    }

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
        .eq("campaign_id", campaignId)
        .not("value", "eq", "");
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

    // batch_size > 1: contatos são agrupados em lotes que saem juntos (ver
    // abaixo), e o cron processa até batch_size itens "agendado" em
    // paralelo por tick (ver cron/route.ts). Sem agrupar aqui no
    // enfileiramento, o pacing sequencial de intervalo_min/max abaixo
    // nunca deixa mais de ~1 item por vez cruzar o limiar scheduled_at
    // <= now, então batch_size nunca tinha efeito prático nenhum —
    // confirmado ao vivo numa campanha com batch_size=10 processando 1-2
    // itens por tick.
    const batchSize = Math.max(1, campaign.batch_size ?? 1);
    const batchPauseMs = (campaign.batch_pause_seconds ?? 0) * 1000;

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

      let contactBaseDelay: number;
      if (batchSize > 1) {
        // Contatos do mesmo lote (mesmo Math.floor(i / batchSize)) recebem
        // o mesmo scheduled_at base — só um jitter de 100ms entre eles pra
        // desempate estável no ORDER BY scheduled_at do cron, não pra
        // espaçar o envio de verdade (o cron já processa o lote inteiro em
        // paralelo). O próximo lote só fica agendado batch_pause_seconds
        // depois. Pausas anti-spam fixas (1h/100, 10min/20) NÃO se
        // aplicam aqui — o usuário já configurou o ritmo manualmente via
        // batch_size/batch_pause_seconds (mesma regra já usada na
        // estimativa de tempo em campanhas/page.tsx: estimarDisparo
        // suprime essas pausas quando batchSizeEfetivo > 1).
        const loteIndex = Math.floor(i / batchSize);
        const jitter = (i % batchSize) * 100;
        contactBaseDelay = loteIndex * batchPauseMs + jitter;
      } else {
        // Comportamento original: pacing sequencial por contato via
        // intervalo_min/max, com pausas anti-spam fixas.
        if (i > 0 && i % 100 === 0) contactDelay += 60 * 60 * 1000; // 1 hour pause every 100 contacts
        else if (i > 0 && i % 20 === 0) contactDelay += 10 * 60 * 1000; // 10 mins pause every 20 contacts
        contactBaseDelay = contactDelay;
      }

      const channel = channelMap.get(sessionId);
      const isMetaChannel = channel?.provider === "meta";

      for (let j = 0; j < mensagens.length; j++) {
        const msg = mensagens[j];
        const msgDelay = contactBaseDelay + j * intraDelay;
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
              account_id: accountId,
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
          account_id: accountId,
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

      // Increment delay for the next contact — só no modo sequencial
      // (batchSize <= 1); no modo em lote, o delay de cada contato é
      // recalculado do zero a partir de `i` a cada iteração.
      if (batchSize <= 1) {
        contactDelay += (mensagens.length - 1) * intraDelay + minDelay + Math.random() * (maxDelay - minDelay);
      }
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
        account_id: accountId,
        total_contatos: contacts.length,
      }, { onConflict: "campaign_id" });

    return { ok: true, enqueued };
  } catch (err: any) {
    console.error("[startCampaign] Failed to schedule queue:", err);
    return { ok: false, status: 500, error: err.message };
  }
}
