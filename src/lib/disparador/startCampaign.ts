import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { loadCampaignAudience } from "@/lib/disparador/audience";
import { resolveUtmLink, type UtmLinkMaps } from "@/lib/disparador/utm-links";
import { phoneKey } from "@/lib/disparador/phone-key";
import { loadBlacklistKeySet } from "@/lib/disparador/blacklist-keys";
import { fetchAllKeyset } from "@/lib/disparador/keyset";
import { insertInBlocks } from "@/lib/disparador/queue-insert";
import { describeEmptyTemplateVar, describeUnresolvedPlaceholder } from "@/lib/disparador/empty-vars";
import { checkCampaignConfig } from "@/lib/disparador/campaign-config-check";
import { formatStartFailureReason, parseTemplateMode } from "@/lib/disparador/campaign-validation";
import { INTRA_CONTACT_MS, roundContactTimeMs, scheduleRounds } from "@/lib/disparador/window-clock";
import { resumeBatchedCampaign } from "@/lib/disparador/queue-reflow";
import { writeLog } from "@/lib/logger";
import { hasDialablePhone, NO_VALID_PHONE_ERROR } from "@/lib/disparador/valid-phone";

// campaigns.dias_permitidos (jsonb "dias da semana permitidos") nunca foi
// lida por este código — reaproveitada para guardar o modo de alternância
// de templates sem precisar de uma migration nova (ver EDITABLE_FIELDS em
// api/disparador/campaigns/[id]/route.ts e o assistente). Linhas antigas
// ainda têm o array-default [1,2,3,4,5,6]; qualquer valor que não seja
// "rotacao"/"aleatorio" cai em "sequencia" ("Padrão" na tela: todas as
// mensagens enviadas em sequência para cada contato). parseTemplateMode e a
// regra de quantidade por modo ficam em campaign-validation.ts.

export interface StartCampaignOptions {
  /**
   * "Iniciar agora" numa campanha agendada: a fila começa agora, não no
   * horário agendado (antes os itens ficavam presos ao agendamento futuro
   * com a campanha já em execução).
   */
  startNow?: boolean;
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
  accountId: string,
  options: StartCampaignOptions = {}
): Promise<StartCampaignResult> {
  // preparing: true enquanto esta chamada é dona da preparação (status
  // 'preparando'). Se sair por erro com ela ainda true, a campanha volta a
  // 'rascunho' para não ficar presa — com o motivo gravado e visível no
  // card (antes uma campanha agendada que falhava voltava a rascunho em
  // silêncio e o agendamento simplesmente sumia).
  const state: PrepareState = { preparing: false, agendamento: null };
  const evaluationSince = new Date().toISOString();
  let result: StartCampaignResult;
  try {
    result = await prepareCampaign(campaignId, accountId, state, options);
  } catch (err: unknown) {
    console.error("[startCampaign] Failed to schedule queue:", err);
    result = { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) };
  }

  if (state.preparing) {
    // Falhou no meio da preparação. Os itens parciais já inseridos não são
    // consumidos (campanha não está em execução) e o próximo start limpa a
    // fila antes de publicar. Falha transitória (5xx/exceção) de campanha
    // COM agendamento volta para 'agendado' — o próximo tick tenta de novo,
    // sem o agendamento sumir; erro de validação (4xx) ou campanha sem
    // agendamento volta para 'rascunho' com o motivo visível no card.
    // Crash do processo não passa por aqui: a recuperação (prepare-campaigns)
    // devolve o que ficar preso em 'preparando' por mais de 30 min.
    const retryable = !result.ok && result.status >= 500 && state.agendamento != null;
    const { error } = await supabaseAdmin()
      .from("campaigns")
      .update({ status: retryable ? "agendado" : "rascunho" })
      .eq("id", campaignId)
      .eq("account_id", accountId)
      .eq("status", "preparando");
    if (error) console.error("[startCampaign] Recuperação de preparação pendente:", error.message);
    if (!result.ok) await recordStartFailure(campaignId, accountId, state.agendamento, result.error);
  } else if (result.ok) {
    await clearStartFailure(campaignId);
    // Vale tanto para retomada sequencial quanto para o reflow do lote.
    // Não reutilizar os erros que motivaram a pausa anterior.
    const { error } = await supabaseAdmin().from("campaigns")
      .update({ pausa_automatica_motivo: null, auto_pausa_avaliar_desde: evaluationSince })
      .eq("id", campaignId).eq("account_id", accountId).eq("status", "em_execucao");
    if (error) console.error("[startCampaign] Falha ao reiniciar avaliação de pausa automática:", error.message);
  }
  return result;
}

/**
 * Renova campaigns.updated_at durante a preparação: a recuperação de campanhas
 * presas (30 min sem updated_at) não pode cortar uma preparação viva. Melhor
 * esforço — falha só é logada.
 */
async function touchPreparing(campaignId: string, accountId: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("campaigns")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("account_id", accountId)
    .eq("status", "preparando");
  if (error) console.error("[startCampaign] Falha ao renovar updated_at da preparação:", error.message);
}

interface PrepareState {
  preparing: boolean;
  /** campaigns.agendamento lido na preparação (para o motivo da falha). */
  agendamento: string | null;
}

// campaigns.motivo_falha_inicio (migration 160). Gravado em UPDATE separado
// e tolerante: sem a coluna, o início/recuperação continuam funcionando.
async function recordStartFailure(
  campaignId: string,
  accountId: string,
  agendamento: string | null,
  error: string
): Promise<void> {
  const motivo = formatStartFailureReason(error, agendamento);
  const { error: updateError } = await supabaseAdmin()
    .from("campaigns")
    .update({ motivo_falha_inicio: motivo })
    .eq("id", campaignId)
    .eq("account_id", accountId);
  if (updateError) console.error("[startCampaign] Falha ao gravar motivo_falha_inicio:", updateError.message);
  void writeLog({
    account_id: accountId,
    level: "warn",
    source: "disparador",
    event: "campaign_start_failed",
    message: motivo,
    payload: { campaign_id: campaignId },
  });
}

async function clearStartFailure(campaignId: string): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("campaigns")
    .update({ motivo_falha_inicio: null })
    .eq("id", campaignId)
    .not("motivo_falha_inicio", "is", null);
  if (error) console.error("[startCampaign] Falha ao limpar motivo_falha_inicio:", error.message);
}

async function prepareCampaign(
  campaignId: string,
  accountId: string,
  state: PrepareState,
  options: StartCampaignOptions
): Promise<StartCampaignResult> {
  // Bloco = antigo corpo do try (indentação preservada para o diff); erro
  // lançado aqui é tratado em startCampaign().
  {
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
      .select("id, agendamento");

    if (claimError) {
      return { ok: false, status: 500, error: claimError.message };
    }
    const claimedFreshStart = !!claimedRows && claimedRows.length > 0;
    state.preparing = claimedFreshStart;
    // O agendamento vem do próprio claim: se a leitura da campanha logo abaixo falhar por erro
    // transitório, a campanha volta a 'agendado' (e não a 'rascunho', perdendo o agendamento).
    if (claimedFreshStart) state.agendamento = claimedRows?.[0]?.agendamento ?? null;

    // 2. Fetch campaign configuration — necessário de todo jeito: quando
    // claimedFreshStart, pra ler mensagens/session_ids/etc; quando não,
    // pra decidir entre "retomar pausada" e um 404/409 com a mensagem
    // certa (o claim acima sozinho não diferencia esses casos).
    // limit(1)+[0] (nunca .single()): erro de LEITURA (rede/5xx) é 500 retentável — a campanha
    // agendada volta a 'agendado' —, e só linha ausente é 404 "não encontrada".
    const { data: campaignRows, error: campaignError } = await supabaseAdmin()
      .from("campaigns")
      .select("*")
      .eq("id", campaignId)
      .eq("account_id", accountId)
      .limit(1);

    if (campaignError) {
      return { ok: false, status: 500, error: `Falha ao ler a campanha: ${campaignError.message}` };
    }
    const campaign = campaignRows?.[0];
    if (!campaign) {
      return { ok: false, status: 404, error: "Campanha não encontrada" };
    }
    state.agendamento = campaign.agendamento ?? null;

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
      // Lote/"Segmentado": a retomada simples poria a fila inteira vencida
      // ao mesmo tempo (rajada). Redistribui no ritmo da campanha antes de
      // reativar (queue-reflow.ts). A validação de template/canal do início
      // não roda na retomada: os itens já estão montados.
      if ((campaign.batch_size ?? 1) > 1) {
        const resumed = await resumeBatchedCampaign(campaign, accountId);
        if (resumed.ok) return { ok: true, enqueued: resumed.resumed };
        if (resumed.reason === "state_changed")
          return { ok: false, status: 409, error: "Estado da campanha mudou; atualize antes de retomar" };
        console.error("[startCampaign] Falha ao retomar campanha em lote:", resumed.error);
        return { ok: false, status: 500, error: "Falha ao retomar campanha" };
      }
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

    // Canais e mensagens, ANTES de mexer na fila (campaign-validation.ts —
    // mesma regra do PATCH e do assistente): só canais da própria conta
    // (session_ids vêm do cliente) e habilitados; nunca Meta + WAHA na
    // mesma campanha; Meta = uma única WABA e toda mensagem é template
    // aprovado, presente no catálogo dessa WABA e compatível (template não
    // aprovado, com mídia no cabeçalho, URL dinâmica ou mais {{n}} do que
    // variáveis mapeadas faria a Meta recusar TODOS os envios).
    const configCheck = await checkCampaignConfig(supabaseAdmin(), accountId, sessionIds, mensagens, {
      templateMode,
      audienceMode: campaign.audience_mode ?? null,
    });
    if (!configCheck.ok) {
      void writeLog({
        account_id: accountId,
        level: "warn",
        source: "disparador",
        event: "campaign_start_config_invalid",
        message: configCheck.error,
        payload: { campaign_id: campaignId },
      });
      return { ok: false, status: configCheck.status, error: configCheck.error };
    }

    const channelMap = new Map(configCheck.channels.map((c) => [c.id, c]));
    const validSessionIds: string[] = [...new Set(sessionIds as string[])].filter((id) => channelMap.has(id));

    // IDs dos canais Meta nesta campanha (todos, ou nenhum — a validação
    // acima não deixa misturar providers).
    const metaSessionIds = configCheck.channels.filter((c) => c.provider === "meta").map((c) => c.id);

    // windowMap: contact_id → Date do último inbound via canal Meta
    // Usado para decidir template vs texto livre no loop de enfileiramento.
    const windowMap = new Map<string, Date>();

    // Só vale a pena consultar o histórico se alguma mensagem puder ir como
    // texto livre num canal Meta (sem template + mapa de variáveis): quando
    // TODAS as mensagens são template, a janela de 24h nunca é usada (B9).
    const needsWindowLookup =
      metaSessionIds.length > 0 &&
      mensagens.some((m: any) => !(m?.template_name && Array.isArray(m?.template_variable_map)));

    if (needsWindowLookup) {
      // Só o que importa para a janela: inbound dos últimos 24h (antes lia o
      // histórico inteiro da conta, custo O(H²/1000) com OFFSET), paginado
      // por KEYSET no id — para achar o MAIS RECENTE por contato a ordem
      // entre páginas não importa, só o máximo de received_at.
      //
      // 'contact' nunca existe em wacrm.messages.sender_type (valores reais:
      // 'customer'/'agent'/'bot', confirmado ao vivo) — com 'contact', esta
      // query sempre voltava vazia e todo envio Meta sem template caía no
      // ramo "fora da janela de 24h" (erro 131026).
      //
      // ERRO AQUI ABORTA a preparação (a campanha volta a 'agendado' e tenta
      // de novo). Antes um erro fazia 'break' silencioso e os contatos ainda
      // não vistos viravam erro permanente "Janela de 24h encerrada" — de
      // forma irreversível.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const inbound = await fetchAllKeyset<{
        id: string;
        received_at: string;
        conversations: { contact_id: string; config_id: string } | null;
      }>("Falha ao consultar a janela de 24h (histórico de mensagens)", (after, limit) => {
        let query = supabaseAdmin()
          .schema("wacrm")
          .from("messages")
          .select("id, received_at, conversations!inner(contact_id, config_id)")
          .eq("sender_type", "customer")
          .in("conversations.config_id", metaSessionIds)
          .gt("received_at", since)
          .order("id", { ascending: true })
          .limit(limit);
        if (after != null) query = query.gt("id", after);
        return query as unknown as PromiseLike<{
          data: Array<{
            id: string;
            received_at: string;
            conversations: { contact_id: string; config_id: string } | null;
          }> | null;
          error: { message: string } | null;
        }>;
      });
      for (const row of inbound) {
        const contactId = row.conversations?.contact_id;
        if (!contactId) continue;
        const at = new Date(row.received_at);
        const current = windowMap.get(contactId);
        if (!current || at > current) windowMap.set(contactId, at);
      }
    }
    await touchPreparing(campaignId, accountId);

    // Público da campanha (src/lib/disparador/audience.ts): CSV ∩
    // tabulações, nunca "a conta inteira" quando a campanha é de CSV.
    // Calculado antes de mexer na fila.
    const audience = await loadCampaignAudience(supabaseAdmin(), accountId, campaign);
    if (!audience.ok) {
      return { ok: false, status: 400, error: audience.error };
    }
    await touchPreparing(campaignId, accountId);

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

    // Mesma fonte paginada usada pela prévia/importação. Assim, o número
    // exibido como "na Blacklist" é exatamente o que é removido da fila.
    const blacklistSet = await loadBlacklistKeySet(supabaseAdmin());

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
      // Keyset por id (sem OFFSET): sem pular nem repetir linhas (B9).
      const sent = await fetchAllKeyset<{ id: string; contact_id: string | null }>(
        "Erro ao carregar contatos já enviados",
        (after, limit) => {
          let query = supabaseAdmin()
            .from("disp_message_queue")
            .select("id, contact_id")
            .eq("campaign_id", campaignId)
            .in("status", ["enviado", "entregue", "lido"])
            .order("id", { ascending: true })
            .limit(limit);
          if (after != null) query = query.gt("id", after);
          return query;
        },
      );
      for (const row of sent) if (row.contact_id) alreadySentContactIds.add(row.contact_id);
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
        // Paginado por keyset (id) — uma campanha grande com UTM pra todo
        // mundo passa de 1000 linhas e, sem paginação, deixaria {{utm_link}}
        // vazio pros contatos fora do corte.
        const links = await fetchAllKeyset<{
          id: number | string;
          phone_normalized: string | null;
          cpf: string | null;
          link_curto: string;
        }>("Falha ao carregar disparador_utm_links", (after, limit) => {
          let query = supabaseAdmin()
            .from("disparador_utm_links")
            .select("id, phone_normalized, cpf, link_curto")
            .eq("campaign_id", campaignId)
            .order("id", { ascending: true })
            .limit(limit);
          if (after != null) query = query.gt("id", after);
          return query;
        });
        for (const row of links) {
          if (row.cpf) utmLinks.byCpf.set(row.cpf, row.link_curto);
          if (row.phone_normalized) utmLinks.byPhone.set(row.phone_normalized, row.link_curto);
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
      // Paginado por keyset (id). Esta tabela tem uma linha por var_index,
      // não por contato — 1000 contatos com VAR1/2/3 já são 3000 linhas
      // (confirmado ao vivo, campanha d5aba714…, 3000 linhas). Erro aqui
      // ABORTA a preparação (a campanha volta a 'agendado'): antes só era
      // logado e todos os contatos saíam com variável vazia, virando erro
      // permanente "variável vazia".
      const csvVars = await fetchAllKeyset<{
        id: number | string;
        contact_id: string;
        var_index: number;
        value: string;
      }>("Falha ao carregar contact_import_variables", (after, limit) => {
        let query = supabaseAdmin()
          .from("contact_import_variables")
          .select("id, contact_id, var_index, value")
          .eq("campaign_id", campaignId)
          .not("value", "eq", "")
          .order("id", { ascending: true })
          .limit(limit);
        if (after != null) query = query.gt("id", after);
        return query;
      });
      for (const row of csvVars) {
        csvVarMap.set(`${row.contact_id}:${row.var_index}`, row.value);
      }
    }
    await touchPreparing(campaignId, accountId);

    // 4. Scheduling queue generation loop
    // ?? (não ||) — intervalo_min/max=0 é um valor legítimo (modo
    // "Personalizado" com delay zero intencional), e || trataria esse 0
    // como falsy e silenciosamente forçaria os defaults de 90s/300s.
    const minDelay = (campaign.intervalo_min ?? 90) * 1000;
    const maxDelay = (campaign.intervalo_max ?? 300) * 1000;
    const intraDelay = INTRA_CONTACT_MS; // 7 s entre mensagens do mesmo contato (131056)

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
    // Se a campanha tem agendamento futuro, usa como base do scheduled_at
    // (ex: start manual antecipado de uma campanha "agendado"). Senão usa
    // Date.now() — inclui o caso normal em que o cron só chama start
    // depois que agendamento já passou, onde essa condição é sempre falsa.
    // "Iniciar agora" (options.startNow) ignora o agendamento futuro.
    const now = new Date().toISOString();
    const baseTime =
      !options.startNow && campaign.agendamento && new Date(campaign.agendamento) > new Date()
        ? new Date(campaign.agendamento).getTime()
        : Date.now();

    // Lote/"Segmentado": horário de cada rodada no relógio de janela
    // (window-clock.ts) — a pausa entre rodadas só conta tempo com a janela
    // aberta e em dia permitido. Antes era base + k·pausa no relógio comum:
    // as rodadas que caíam à noite/no fim de semana venciam todas juntas e
    // saíam numa rajada na abertura seguinte. Ritmo e tamanho do lote não
    // mudam. Índice da rodada = Math.floor(i / batchSize), igual a antes.
    const roundTimes =
      batchSize > 1
        ? scheduleRounds(
            new Date(baseTime),
            Math.ceil(contacts.length / batchSize),
            campaign.batch_pause_seconds ?? 0,
            { inicio: campaign.janela_inicio, fim: campaign.janela_fim, dias: campaign.dias_envio }
          )
        : [];

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
        // Contatos do mesmo lote (mesmo Math.floor(i / batchSize)) vencem
        // juntos: horário da rodada + um espalhamento de no máximo 2 s na
        // rodada inteira (roundSpreadOffsetMs) — só para manter a ordem e
        // os empates do ORDER BY (scheduled_at, id) do cron pequenos, não
        // para espaçar o envio. Antes era 100 ms × posição: no "Imediato"
        // (rodada única) 50 mil contatos levavam ~83 min só para vencer.
        // Quem dá o ritmo são as vagas do motor (max_in_flight por número,
        // concorrência, limite_por_hora). O próximo lote só fica agendado batch_pause_seconds
        // de janela aberta depois (roundTimes). Pausas anti-spam fixas (1h/100, 10min/20) NÃO se
        // aplicam aqui — o usuário já configurou o ritmo manualmente via
        // batch_size/batch_pause_seconds (mesma regra já usada na
        // estimativa de tempo em campanhas/page.tsx: estimarDisparo
        // suprime essas pausas quando batchSizeEfetivo > 1).
        contactBaseDelay = roundContactTimeMs(roundTimes, i, batchSize, contacts.length) - baseTime;
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

      // Contato sem telefone válido não entra na fila como envio: registra UM erro permanente
      // explicado (nunca cai no telefone "inventado" a partir do texto da mensagem).
      if (!hasDialablePhone(contact.phone)) {
        const firstMsg = messagesToSend[0];
        queueRows.push({
          campaign_id: campaignId,
          account_id: accountId,
          contact_id: contact.id,
          session_id: sessionId,
          mensagem_final: firstMsg?.conteudo || firstMsg?.prompt || "",
          status: "erro",
          erro_permanente: true,
          erro: NO_VALID_PHONE_ERROR,
          tipo: firstMsg?.tipo || "texto",
          media_url: firstMsg?.url || null,
          scheduled_at: new Date(baseTime + contactBaseDelay).toISOString(),
          template_name: null,
          template_language: null,
          template_variables: null,
        });
        enqueued++;
        continue;
      }

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
          // O bloco pode conter também linhas de erro com
          // erro_permanente=true. Em bulk inserts heterogêneos o PostgREST
          // pode materializar a chave ausente como NULL em vez de usar o
          // DEFAULT da coluna. Como a coluna é NOT NULL, toda linha precisa
          // enviar o boolean explicitamente.
          erro_permanente: false,
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
      // Blocos de 1.000, até 3 em paralelo; cada bloco gravado renova o
      // updated_at da campanha (a recuperação de 30 min não corta uma
      // preparação viva). Qualquer erro aborta e sobe para startCampaign().
      await insertInBlocks(
        queueRows,
        (block) => supabaseAdmin().from("disp_message_queue").insert(block),
        { onBlockDone: () => touchPreparing(campaignId, accountId) },
      );
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
    state.preparing = false;

    return { ok: true, enqueued };
  }
}
