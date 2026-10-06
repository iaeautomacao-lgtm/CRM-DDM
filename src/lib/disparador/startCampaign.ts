import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { loadCampaignAudience } from "@/lib/disparador/audience";
import { resolveUtmLink, type UtmLinkMaps } from "@/lib/disparador/utm-links";
import { phoneKey } from "@/lib/disparador/phone-key";
import { describeEmptyTemplateVar, describeUnresolvedPlaceholder } from "@/lib/disparador/empty-vars";
import {
  TEMPLATE_VALIDATION_COLUMNS,
  validateCampaignTemplate,
  type LocalTemplateRow,
} from "@/lib/disparador/template-validation";
import { writeLog } from "@/lib/logger";

type TemplateMode = "sequencia" | "rotacao" | "aleatorio";

// campaigns.dias_permitidos (jsonb "dias da semana permitidos") nunca foi
// lida por este código — reaproveitada para guardar o modo de alternância
// de templates sem precisar de uma migration nova (ver EDITABLE_FIELDS em
// api/disparador/campaigns/[id]/route.ts e campanhas/page.tsx). Linhas
// antigas ainda têm o array-default [1,2,3,4,5,6]; qualquer valor que não
// seja "rotacao"/"aleatorio" cai em "sequencia" (comportamento original:
// todas as mensagens enviadas em sequência para cada contato).
function parseTemplateMode(raw: unknown): TemplateMode {
  return raw === "rotacao" || raw === "aleatorio" ? raw : "sequencia";
}

// Valida os templates Meta das mensagens contra o catálogo local
// (wacrm.message_templates). Devolve a primeira mensagem de erro, ou null.
// Erro ao ler o catálogo não bloqueia o início (só loga) — é uma checagem
// de segurança, não uma dependência do envio.
interface TemplateMessageFields {
  template_name?: unknown;
  template_language?: unknown;
  template_variable_map?: unknown;
}

async function validateCampaignTemplates(
  mensagens: readonly TemplateMessageFields[],
  accountId: string,
  wabaIds: string[]
): Promise<string | null> {
  const templateMessages = mensagens
    .filter((m) => m?.template_name && Array.isArray(m.template_variable_map))
    .map((m) => ({
      templateName: String(m.template_name),
      language: typeof m.template_language === "string" && m.template_language ? m.template_language : "pt_BR",
      mappedVariables: (m.template_variable_map as unknown[]).length,
    }));
  if (templateMessages.length === 0) return null;
  const names = [...new Set(templateMessages.map((m) => m.templateName))];
  const { data: rows, error } = await supabaseAdmin()
    .from("message_templates")
    .select(TEMPLATE_VALIDATION_COLUMNS)
    .eq("account_id", accountId)
    .in("name", names);
  if (error) {
    console.error("[startCampaign] Falha ao ler message_templates para validação:", error.message);
    return null;
  }
  for (const m of templateMessages) {
    const result = validateCampaignTemplate({
      ...m,
      rows: (rows ?? []) as LocalTemplateRow[],
      wabaIds,
    });
    if (!result.ok) return result.error;
    if (!result.checked) {
      console.warn(
        `[startCampaign] Template "${m.templateName}" (${m.language}) fora do catálogo local — status/componentes não validados.`
      );
    }
  }
  return null;
}

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
  // true enquanto esta chamada é dona da preparação (status 'preparando').
  // Se sair por erro com ela ainda true, o finally devolve a campanha a
  // 'rascunho' para não ficar presa.
  let preparing = false;
  try {
    // 1. Claim condicional rascunho/agendado -> 'preparando'. Enquanto a
    // fila é montada a campanha NÃO está 'em_execucao', então o cron e o
    // claim_dispatch_item ignoram os itens já inseridos — nenhum consumidor
    // começa a enviar um lote incompleto. Também impede dois starts
    // simultâneos: só um UPDATE encontra o status de origem.
    const { data: claimedRows, error: claimError } = await supabaseAdmin()
      .from("campaigns")
      // updated_at marca o início da preparação: o cron devolve a
      // 'rascunho' o que ficar preso aqui por um crash.
      .update({ status: "preparando", updated_at: new Date().toISOString() })
      .eq("id", campaignId)
      .eq("account_id", accountId)
      .in("status", ["rascunho", "agendado"])
      .select("id");

    if (claimError) {
      return { ok: false, status: 500, error: claimError.message };
    }
    const claimedFreshStart = !!claimedRows && claimedRows.length > 0;
    preparing = claimedFreshStart;

    // 2. Fetch campaign configuration — necessário de todo jeito: quando
    // claimedFreshStart, pra ler mensagens/session_ids/etc; quando não,
    // pra decidir entre "retomar pausada" e um 404/409 com a mensagem
    // certa (o claim acima sozinho não diferencia esses casos).
    const { data: campaign, error: campaignError } = await supabaseAdmin()
      .from("campaigns")
      .select("*")
      .eq("id", campaignId)
      .eq("account_id", accountId)
      .single();

    if (campaignError || !campaign) {
      return { ok: false, status: 404, error: "Campanha não encontrada" };
    }

    // Not claimed above (não era rascunho/agendado) e não é retomada de
    // pausada — genuinamente não iniciável agora. Enforced aqui, não só
    // desabilitado na UI, pra uma chamada direta não conseguir reiniciar
    // uma campanha já em execução nem reabrir uma já encerrada.
    if (!claimedFreshStart && campaign.status !== "pausada") {
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
      // RPC (migration 118) faz tudo numa transação com lock da campanha:
      // confirma 'pausada', volta itens 'pausado' -> 'agendado' e põe a
      // campanha em 'em_execucao'. Retorna NULL se o status mudou nesse
      // meio-tempo (ex.: outro usuário encerrou), evitando reabrir a fila.
      const { data: count, error } = await supabaseAdmin().rpc("resume_dispatch_campaign", {
        p_campaign_id: campaignId,
        p_account_id: accountId,
      });
      if (error) return { ok: false, status: 500, error: "Falha ao retomar campanha" };
      if (count === null)
        return {
          ok: false,
          status: 409,
          error: "Estado da campanha mudou; atualize antes de retomar",
        };
      return { ok: true, enqueued: count };
    }

    const mensagens = Array.isArray(campaign.mensagens) ? campaign.mensagens : [];
    if (mensagens.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "Campanha sem mensagens configuradas.",
      };
    }
    const templateMode = parseTemplateMode(campaign.dias_permitidos);

    const sessionIds = Array.isArray(campaign.session_ids) ? campaign.session_ids : [];
    if (sessionIds.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "Campanha sem sessões de WhatsApp selecionadas.",
      };
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
        console.error(
          "[startCampaign] Falha ao relinkar contact_import_variables:",
          csvVarRelinkErr
        );
      }
    }

    // Buscar provider de cada canal selecionado na campanha
    // Só canais da própria conta: session_ids vêm do cliente (antes um UUID
    // de outra conta bastava para disparar por ela).
    const { data: channelConfigs } = await supabaseAdmin()
      .from("whatsapp_config")
      .select("id, provider, phone_number_id, waba_id")
      .in("id", sessionIds)
      .eq("account_id", accountId);

    const channelMap = new Map((channelConfigs ?? []).map((c) => [c.id, c]));
    const validSessionIds = sessionIds.filter((id: string) => channelMap.has(id));
    if (validSessionIds.length === 0) {
      return {
        ok: false,
        status: 400,
        error: "Nenhum dos canais selecionados pertence a esta conta.",
      };
    }

    // IDs dos canais Meta nesta campanha (só os válidos da conta)
    const metaChannels = (channelConfigs ?? []).filter((c) => c.provider === "meta");
    const metaSessionIds = metaChannels.map((c) => c.id);

    // Fail fast do template Meta, ANTES de mexer na fila: template não
    // aprovado, com componente que o disparador não preenche (mídia no
    // cabeçalho, URL dinâmica...) ou com mais {{n}} do que variáveis
    // mapeadas faria a Meta recusar TODOS os envios — ver
    // template-validation.ts. Só o caminho Meta usa template; contatos em
    // canal WAHA recebem o corpo como texto (bifurcação mais abaixo).
    if (metaSessionIds.length > 0) {
      const templateProblem = await validateCampaignTemplates(
        mensagens,
        accountId,
        metaChannels.map((c) => c.waba_id).filter((w): w is string => !!w)
      );
      if (templateProblem) {
        void writeLog({
          account_id: accountId,
          level: "warn",
          source: "disparador",
          event: "campaign_start_template_invalid",
          message: templateProblem,
          payload: { campaign_id: campaignId },
        });
        return { ok: false, status: 400, error: templateProblem };
      }
    }

    // windowMap: contact_id → Date do último inbound via canal Meta
    // Usado para decidir template vs texto livre no loop de enfileiramento
    const windowMap = new Map<string, Date>();

    if (metaSessionIds.length > 0) {
      // Paginado via .range() — mesmo padrão de allContacts/blacklist
      // acima. Sem paginação, uma conta com mais de 1000 mensagens de
      // clientes no histórico batia no cap de resposta do PostgREST: só
      // as 1000 mais recentes (globalmente, não por contato) vinham,
      // então contatos cujo último inbound estava fora desse corte
      // ficavam de fora do windowMap e caíam no ramo "janela de 24h
      // encerrada" mesmo tendo respondido há minutos.
      //
      // A ordenação DESC por received_at é preservada entre páginas — o
      // Postgres ordena o resultado inteiro antes de paginar, não cada
      // página isoladamente — então a primeira ocorrência de cada
      // contact_id ao longo de TODAS as páginas continua sendo a mais
      // recente. windowMap.has() abaixo só grava essa primeira ocorrência
      // por contato, exatamente como antes; só precisou passar a rodar
      // por página em vez de sobre o array inteiro de uma vez.
      //
      // Erro aqui não aborta o início da campanha (nunca abortou, mesmo
      // antes desta correção) — windowMap fica com o que já foi
      // acumulado até a página que falhou, e contatos ainda não vistos
      // degradam para "janela fechada" (mesmo comportamento de sempre
      // pra um contato sem entrada no Map).
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data: page, error: pageError } = await supabaseAdmin()
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
          .order("received_at", { ascending: false })
          .range(from, from + pageSize - 1);

        if (pageError) {
          console.error(
            "[startCampaign] Falha ao paginar histórico de mensagens (janela 24h):",
            pageError.message
          );
          break;
        }

        for (const row of page ?? []) {
          const conv = row.conversations as unknown as {
            contact_id: string;
            config_id: string;
          };
          if (conv?.contact_id && !windowMap.has(conv.contact_id)) {
            windowMap.set(conv.contact_id, new Date(row.received_at));
          }
        }

        if (!page || page.length < pageSize) break;
        from += pageSize;
      }
    }

    // Público da campanha (src/lib/disparador/audience.ts): CSV ∩
    // tabulações, nunca "a conta inteira" quando a campanha é de CSV.
    // Calculado antes de mexer na fila.
    const audience = await loadCampaignAudience(supabaseAdmin(), accountId, campaign);
    if (!audience.ok) {
      return { ok: false, status: 400, error: audience.error };
    }

    // 2. Remove previously scheduled/pending items to prevent duplication.
    // 'enviando' incluído para limpar itens travados por crash/deploy
    // anterior (processo derrubado entre o claim e o update final). Erro
    // checado — se essa limpeza falhar silenciosamente, linhas velhas
    // convivem com o lote novo inserido mais abaixo e contatos podem
    // receber a mensagem duplicada.
    const { error: cleanupError } = await supabaseAdmin()
      .from("disp_message_queue")
      .delete()
      .eq("campaign_id", campaignId)
      .in("status", ["pendente", "agendado", "erro", "enviando"]);

    if (cleanupError) {
      return { ok: false, status: 500, error: cleanupError.message };
    }

    // 3. Público (contatos já filtrados por CSV ∩ tabulações) — calculado
    // antes da limpeza da fila, ver audience acima.
    const contacts = audience.contacts;

    // Fetch Blacklist to skip — paginado via .range(), mesmo padrão de
    // allContacts/contact_import_variables acima: sem filtro nenhum (a
    // blacklist não tem account_id, ver import/route.ts) e sem
    // paginação, uma blacklist com mais de 1000 números batia no cap de
    // resposta do PostgREST e truncava silenciosamente — números fora do
    // corte paravam de ser excluídos, sem erro nenhum.
    const blacklist: Array<{ telefone: string }> = [];
    {
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data: page, error: pageError } = await supabaseAdmin()
          .from("blacklist")
          .select("telefone")
          .range(from, from + pageSize - 1);
        if (pageError) {
          throw new Error(`Erro ao carregar blacklist: ${pageError.message}`);
        }
        blacklist.push(...(page ?? []));
        if (!page || page.length < pageSize) break;
        from += pageSize;
      }
    }
    // Comparação por chave (DDD + 8 últimos dígitos): entradas antigas sem
    // 55 ou sem o 9º dígito também bloqueiam — ver phone-key.ts.
    const blacklistSet = new Set(blacklist.map((b) => phoneKey(b.telefone)));

    // Contatos que já receberam com sucesso numa tentativa anterior desta
    // campanha (ex: a campanha falhou no meio — chunk de insert quebrou,
    // deploy no meio do processamento — e o usuário reiniciou). O DELETE
    // de limpeza acima só remove pendente/agendado/erro/enviando; linhas
    // já enviadas ficam intactas e são a fonte da verdade de "quem já foi
    // contatado" — sem isso, reiniciar uma campanha reenvia pra todo
    // mundo, inclusive quem já recebeu. Paginado via .range() — mesmo
    // padrão do restante do arquivo.
    const alreadySentContactIds = new Set<string>();
    {
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data: page, error: pageError } = await supabaseAdmin()
          .from("disp_message_queue")
          .select("contact_id")
          .eq("campaign_id", campaignId)
          .in("status", ["enviado", "entregue", "lido"])
          .range(from, from + pageSize - 1);
        if (pageError) {
          throw new Error(`Erro ao carregar contatos já enviados: ${pageError.message}`);
        }
        for (const row of page ?? []) {
          if (row.contact_id) alreadySentContactIds.add(row.contact_id);
        }
        if (!page || page.length < pageSize) break;
        from += pageSize;
      }
    }

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
    const utmLinks: UtmLinkMaps = { byCpf: new Map(), byPhone: new Map() };
    if (usaUtmLink) {
      try {
        // Paginado via .range() — mesmo padrão do restante do arquivo.
        // Uma campanha grande com UTM pra todo mundo pode passar de 1000
        // linhas e, sem paginação, deixar {{utm_link}} vazio pros
        // contatos fora do corte (mesma classe de bug já corrigida em
        // blacklist/contacts/contact_import_variables acima).
        const pageSize = 1000;
        let from = 0;
        while (true) {
          const { data: page, error: utmLinksError } = await supabaseAdmin()
            .from("disparador_utm_links")
            .select("phone_normalized, cpf, link_curto")
            .eq("campaign_id", campaignId)
            .range(from, from + pageSize - 1);
          if (utmLinksError) throw utmLinksError;
          for (const row of page ?? []) {
            if (row.cpf) utmLinks.byCpf.set(row.cpf, row.link_curto);
            if (row.phone_normalized) utmLinks.byPhone.set(row.phone_normalized, row.link_curto);
          }
          if (!page || page.length < pageSize) break;
          from += pageSize;
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
      // Paginado via .range() — mesmo padrão de allContacts (acima) e do
      // filtro por tag (abaixo). Esta tabela tem uma linha por var_index,
      // não por contato — uma campanha com 1000 contatos usando VAR1/2/3
      // já soma 3000 linhas, o que sem paginação batia no cap de resposta
      // do PostgREST (1000) e truncava silenciosamente: só os primeiros
      // ~333 contatos ficavam com entradas no csvVarMap, e os outros
      // ~667 recebiam template_variables vazio (confirmado ao vivo,
      // campaign_id d5aba714-a8d1-4579-8ab1-15a62e9cfcc7, 3000 linhas).
      const csvVars: Array<{
        contact_id: string;
        var_index: number;
        value: string;
      }> = [];
      const pageSize = 1000;
      let from = 0;
      let csvVarsError: { message: string } | null = null;
      while (true) {
        const { data: page, error: pageError } = await supabaseAdmin()
          .from("contact_import_variables")
          .select("contact_id, var_index, value")
          .eq("campaign_id", campaignId)
          .not("value", "eq", "")
          .range(from, from + pageSize - 1);
        if (pageError) {
          csvVarsError = pageError;
          break;
        }
        csvVars.push(...(page ?? []));
        if (!page || page.length < pageSize) break;
        from += pageSize;
      }
      if (csvVarsError) {
        console.error(
          "[startCampaign] Falha ao carregar contact_import_variables:",
          csvVarsError.message
        );
      } else {
        for (const row of csvVars) {
          csvVarMap.set(`${row.contact_id}:${row.var_index}`, row.value);
        }
      }
    }

    // 4. Scheduling queue generation loop
    // ?? (não ||) — intervalo_min/max=0 é um valor legítimo (modo
    // "Personalizado" com delay zero intencional), e || trataria esse 0
    // como falsy e silenciosamente forçaria os defaults de 90s/300s.
    const minDelay = (campaign.intervalo_min ?? 90) * 1000;
    const maxDelay = (campaign.intervalo_max ?? 300) * 1000;
    const intraDelay = 3000; // 3 seconds between messages for the same contact

    // batch_size > 1: contatos são agrupados em lotes que saem juntos (ver
    // abaixo), e o cron processa até batch_size itens "agendado" em
    // paralelo por tick (ver cron/route.ts). Sem agrupar aqui no
    // enfileiramento, o pacing sequencial de intervalo_min/max abaixo
    // nunca deixa mais de ~1 item por vez cruzar o limiar scheduled_at
    // <= now, então batch_size nunca tinha efeito prático nenhum —
    // confirmado ao vivo numa campanha com batch_size=10 processando 1-2
    // itens por tick.
    // Modo "Segmentado" (campaigns.batch_percent, migration 114) — resolve
    // o percentual contra o total real de contatos AGORA (no início de
    // fato, não em quando a campanha foi criada/editada — a lista pode ter
    // crescido/encolhido desde lá) e grava o batch_size absoluto resultante
    // de volta em campaigns, para que cron/route.ts continue lendo só essa
    // coluna sem precisar saber que "Segmentado" existe. Detectado por
    // batch_percent IS NOT NULL, não por uma coluna dispatch_mode — não
    // existe nenhuma no schema (DispatchMode é puramente um conceito de UI
    // em campanhas/page.tsx, inferido a partir dos campos técnicos — ver
    // comentário na própria migration 114).
    let batchSize = Math.max(1, campaign.batch_size ?? 1);
    if (campaign.batch_percent != null && campaign.batch_percent > 0) {
      batchSize = Math.max(1, Math.ceil(contacts.length * (campaign.batch_percent / 100)));
      const { error: batchSizeUpdateError } = await supabaseAdmin()
        .from("campaigns")
        .update({ batch_size: batchSize })
        .eq("id", campaignId);
      if (batchSizeUpdateError) {
        console.error(
          "[startCampaign] Falha ao gravar batch_size resolvido do modo Segmentado:",
          batchSizeUpdateError.message
        );
      }
    }
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
      if (contact.phone && blacklistSet.has(phoneKey(contact.phone))) continue;

      // Skip contatos que já receberam com sucesso numa tentativa
      // anterior desta mesma campanha (ver alreadySentContactIds acima).
      if (alreadySentContactIds.has(contact.id)) continue;

      // Distribuição round-robin entre os canais selecionados — cada canal
      // recebe uma fatia igual dos contatos, em vez do sorteio aleatório
      // anterior (só estatisticamente uniforme, sem garantia de balanço).
      const sessionId = validSessionIds[i % validSessionIds.length];

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
        if (i > 0 && i % 100 === 0)
          contactDelay += 60 * 60 * 1000; // 1 hour pause every 100 contacts
        else if (i > 0 && i % 20 === 0) contactDelay += 10 * 60 * 1000; // 10 mins pause every 20 contacts
        contactBaseDelay = contactDelay;
      }

      const channel = channelMap.get(sessionId);
      const isMetaChannel = channel?.provider === "meta";

      // template_mode "sequencia" (default) manda todas as mensagens
      // configuradas, em ordem, para cada contato — comportamento
      // original. "rotacao"/"aleatorio" mandam só UMA mensagem por
      // contato, escolhida entre as configuradas (round-robin por índice
      // do contato, ou sorteio) — pensado para alternar templates
      // diferentes entre contatos, não para uma sequência ao mesmo
      // contato.
      const messagesToSend =
        templateMode === "sequencia"
          ? mensagens
          : templateMode === "rotacao"
            ? [mensagens[i % mensagens.length]]
            : [mensagens[Math.floor(Math.random() * mensagens.length)]];

      for (let j = 0; j < messagesToSend.length; j++) {
        const msg = messagesToSend[j];
        const msgDelay = contactBaseDelay + j * intraDelay;
        const scheduledAt = new Date(baseTime + msgDelay).toISOString();

        // Store the raw template text — {{variavel}} and legacy {nome}
        // placeholders are resolved at send time (processQueueItem) via
        // applyTemplateVars, not here, so they reflect the contact's
        // current data and today's date rather than a snapshot from enqueue.
        const rawText = msg.conteudo || msg.prompt || "";
        let resolvedText = rawText;

        // Meta template fields — resolved per-contact from template_variable_map
        // (populated in campanhas/page.tsx only when the message came from the
        // Meta template catalog). Null for WAHA / non-template messages.
        let templateName: string | null = null;
        let templateLanguage: string | null = null;
        let templateVariables: string[] | null = null;

        // Bifurcação Meta × WAHA pelo CANAL do contato, não pela mensagem:
        // numa campanha com canais dos dois tipos, o contato que cai num
        // canal WAHA recebe o corpo do template com {{n}} substituído no
        // código; antes ia com template_name e "{{1}} {{2}}" literal.
        if (isMetaChannel && msg.template_name && Array.isArray(msg.template_variable_map)) {
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
              return resolveUtmLink(utmLinks, contact as any);
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

        // WAHA free-text: apply {{N}} substitution at enqueue time because there
        // is no Meta API to resolve placeholders — the text must arrive at
        // processQueueItem already substituted.
        let wahaEmptyVar: number | null = null;
        if (!(isMetaChannel && msg.template_name) && Array.isArray(msg.template_variable_map)) {
          resolvedText = msg.template_variable_map.reduce(
            (text: string, entry: any, idx: number) => {
              let value = "";
              if (entry?.type === "contact_field") {
                value = String((contact as any)[entry.field] ?? "");
              } else if (entry?.type === "utm_link") {
                value = resolveUtmLink(utmLinks, contact as any);
              } else if (entry?.type === "csv_var") {
                value = csvVarMap.get(`${contact.id}:${entry.index}`) ?? "";
              } else {
                value = String(entry?.value ?? "");
              }
              const placeholder = new RegExp(`\\{\\{${idx + 1}\\}\\}`, "g");
              if (!value.trim() && wahaEmptyVar === null && placeholder.test(text)) wahaEmptyVar = idx + 1;
              return text.replace(placeholder, value);
            },
            resolvedText
          );
        }

        // Validação de janela 24h para canais Meta sem template
        if (isMetaChannel && !templateName) {
          const lastInbound = windowMap.get(contact.id);
          const windowOpen =
            lastInbound != null && Date.now() - lastInbound.getTime() < 24 * 60 * 60 * 1000;

          if (!windowOpen) {
            // Contato fora da janela e sem template — enfileira como
            // erro imediato em vez de tentar enviar (a Meta rejeitaria
            // com 131026). Conta para métricas e aparece na UI.
            queueRows.push({
              campaign_id: campaignId,
              account_id: accountId,
              contact_id: contact.id,
              session_id: sessionId,
              mensagem_final: resolvedText,
              status: "erro",
              // Permanente: sem isso o retry automático reenviava como texto
              // livre, a Meta devolvia 131047 e o telefone (bom) era marcado
              // como inválido.
              erro_permanente: true,
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

        // Variável vazia ou {{n}} sem fonte: não envia "Olá , seu débito de
        // R$ " para o cliente (na Meta ainda daria erro 131008). O contato
        // fica com erro permanente explicando qual variável faltou.
        const emptyVarProblem = templateName
          ? describeEmptyTemplateVar(templateVariables ?? [])
          : describeUnresolvedPlaceholder(resolvedText, wahaEmptyVar);
        if (emptyVarProblem) {
          queueRows.push({
            campaign_id: campaignId,
            account_id: accountId,
            contact_id: contact.id,
            session_id: sessionId,
            mensagem_final: resolvedText,
            status: "erro",
            erro_permanente: true,
            erro: emptyVarProblem,
            tipo: msg.tipo || "texto",
            media_url: msg.url || null,
            scheduled_at: scheduledAt,
            template_name: templateName,
            template_language: templateLanguage,
            template_variables: templateVariables,
          });
          enqueued++;
          continue;
        }

        queueRows.push({
          campaign_id: campaignId,
          account_id: accountId,
          contact_id: contact.id,
          session_id: sessionId,
          mensagem_final: resolvedText,
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
      // recalculado do zero a partir de `i` a cada iteração. Usa
      // messagesToSend.length (não mensagens.length) para refletir quantas
      // mensagens ESTE contato recebeu — em rotacao/aleatorio é sempre 1,
      // então não soma intraDelay extra que nunca é usado.
      if (batchSize <= 1) {
        contactDelay +=
          (messagesToSend.length - 1) * intraDelay +
          minDelay +
          Math.random() * (maxDelay - minDelay);
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

    // Update Metrics
    const { error: metricsError } = await supabaseAdmin().from("campaign_metrics").upsert(
      {
        campaign_id: campaignId,
        account_id: accountId,
        // Contatos que de fato entraram na fila (sem blacklist e sem quem já
        // recebeu numa tentativa anterior) — antes era o público bruto.
        total_contatos: new Set(queueRows.map((r) => r.contact_id)).size,
      },
      { onConflict: "campaign_id" }
    );

    if (metricsError) throw metricsError;

    // Publicação: só agora a campanha vira 'em_execucao' e os itens ficam
    // visíveis para os consumidores. O filtro status='preparando' garante
    // que não ativamos uma campanha que foi encerrada/alterada durante a
    // preparação. next_batch_at=null libera o primeiro lote imediatamente.
    const { data: activated, error: activateError } = await supabaseAdmin()
      .from("campaigns")
      .update({ status: "em_execucao", agendamento: now, next_batch_at: null })
      .eq("id", campaignId)
      .eq("account_id", accountId)
      .eq("status", "preparando")
      .select("id");

    if (activateError || !activated?.length) {
      return { ok: false, status: 500, error: "Falha ao ativar campanha" };
    }
    preparing = false;

    return { ok: true, enqueued };
  } catch (err: any) {
    console.error("[startCampaign] Failed to schedule queue:", err);
    return { ok: false, status: 500, error: err.message };
  } finally {
    if (preparing) {
      // Falhou no meio da preparação: volta para 'rascunho'. Os itens
      // parciais já inseridos não são consumidos (campanha não está em
      // execução) e o próximo start limpa a fila antes de publicar.
      // Crash do processo não passa por aqui: campanha presa em
      // 'preparando' exige revisão manual.
      const { error } = await supabaseAdmin()
        .from("campaigns")
        .update({ status: "rascunho" })
        .eq("id", campaignId)
        .eq("account_id", accountId)
        .eq("status", "preparando");
      if (error)
        console.error("[startCampaign] Recuperação de preparação pendente:", error.message);
    }
  }
}
