import {
  sendWahaTextMessage,
  sendWahaMediaMessage,
  sendWahaVoiceMessage,
  startWacallsCall,
  playWacallsAudio,
  getWacallsCallStatus,
  assertWahaUrlIsSafe,
} from "@/lib/whatsapp/waha-api";
import {
  sendTemplateMessage,
  sendTextMessage,
  sendMediaMessage,
  MetaApiError,
} from "@/lib/whatsapp/meta-api";
import { decryptStoredSecret } from "@/lib/whatsapp/encryption";
import { safeFetch } from "@/lib/security/ssrf-guard";
import { applyTemplateVars } from "@/lib/disparador/template-vars";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { resolveProviderMedia } from '@/lib/storage/provider-media';
import { writeLog, maskPhone } from "@/lib/logger";
import { autoBlacklistOn131026 } from "@/lib/disparador/auto-blacklist";

// Marcador de contato externo WAHA — definido em queue-markers.ts e
// reexportado aqui para os imports existentes continuarem funcionando.
import { EXTERNAL_WAHA_TEXT_MARKER } from "@/lib/disparador/queue-markers";
import { phoneVariants } from "@/lib/disparador/phone-key";
import { canSendNow, isWithinSendWindow, nextSendSlot } from "@/lib/disparador/send-window";
import { classifyProviderError, type BackoffReason } from "@/lib/disparador/provider-signals";
import { DB_DEFAULT_MAX_IN_FLIGHT } from "@/lib/disparador/throughput-config";
import { queueItemPrimaryPhone, type BlacklistLookup } from "@/lib/disparador/tick-preload";
import { hasDialablePhone, NO_VALID_PHONE_ERROR } from "@/lib/disparador/valid-phone";
import { AI_UNAVAILABLE_ERROR, isNotConnectedError, NOT_CONNECTED_ERROR, UNCERTAIN_OUTCOME_ERROR } from "@/lib/disparador/provider-outcome";
import { generateDispatchAiText } from "@/lib/disparador/dispatch-ai";
import { loadCampaignStatusCounts, summarizeStatusCounts } from "@/lib/disparador/campaign-status-counts";
export { EXTERNAL_WAHA_TEXT_MARKER };

export interface QueueItem {
  id: string;
  campaign_id: string;
  contact_id: string | null;
  session_id: string;
  tipo: string;
  mensagem_final: string;
  media_url?: string;
  tentativas?: number;
  contacts?: { name?: string; phone?: string; company?: string };
  // Migration 070 — campos de template Meta (business-initiated /
  // fora da janela de 24h). Ausentes/undefined em itens WAHA.
  template_name?: string;
  template_language?: string;
  template_variables?: string[];
  // Migration 077 — índice do telefone tentado em wacrm.contact_phones
  // (1 = contacts.phone, o principal; 2/3 = alternativos). Não precisa
  // ser adicionado a nenhum select manualmente: worker.ts/cron/
  // claimQueueItem já usam `select("*", ...)`, que já traz a coluna
  // assim que a migration for aplicada — este campo é só o tipo TS.
  phone_attempt_order?: number;
  /** disp_message_queue.scheduled_at (já vem no select("*")). */
  scheduled_at?: string | null;
}

export interface Campaign {
  id: string;
  status: string;
  janela_inicio?: string;
  janela_fim?: string;
  // Migration 078 — disparo em lote (ver worker.ts). batch_size = itens
  // processados em paralelo por tick; batch_pause_seconds = pausa entre
  // lotes consecutivos; limite_por_hora já existia no schema mas nunca
  // era lido antes desta feature.
  batch_size?: number;
  batch_pause_seconds?: number;
  limite_por_hora?: number;
  /** Dias da semana permitidos (0=dom…6=sáb, Brasília); vazio = todos (144). */
  dias_envio?: number[] | null;
  /** Quando presente, o canal (whatsapp_config) precisa ser desta conta. */
  account_id?: string;
}

// Resultado de processQueueItem:
// - sent: provedor aceitou e a confirmação local foi gravada.
// - deferred: item reagendado (fora da janela, telefone alternativo...).
// - blocked: contato na blacklist; não haverá envio.
// - pending_confirmation: reservado só para aceite confirmado pelo
//   provedor cuja gravação local falhou (há message id para reconciliar).
// - timeout/5xx/rede sem message id viram erro terminal inconclusivo:
//   nunca são reenviados e nunca ocupam max_in_flight indefinidamente.
// - error: rejeição comprovada do provedor ou falha antes do envio.
export type ProcessResult =
  | { outcome: "sent"; messageId: string }
  | { outcome: "deferred"; reason: string }
  | { outcome: "blocked"; reason: string }
  | { outcome: "pending_confirmation"; messageId?: string; reason: string }
  | { outcome: "error"; error: string };

// Após esse número de tentativas, o item é marcado como erro permanente
// em vez de reentrar no funil de reenvio (ver markQueueError).
const MAX_TENTATIVAS = 5;

// Reivindica atomicamente um item (agendado -> enviando) via RPC
// wacrm.claim_dispatch_item (migration 118). Dentro de uma transação, a RPC:
// - trava a campanha (FOR UPDATE) e exige status 'em_execucao';
// - trava o canal (advisory lock por session_id) para serializar claims de
//   campanhas diferentes que usam o mesmo número;
// - confere limite_por_hora da campanha, max_in_flight e hourly_limit do
//   canal (dispatch_channel_limits), contando também itens 'enviando';
// - recusa item já com waha_message_id (já aceito pelo provedor).
// Só um chamador vence; os demais recebem false e pulam o item.
//
// Sem a migration 118 a RPC não existe e o erro é propagado de propósito:
// o fallback antigo (UPDATE simples) não respeitava quota nem concorrência
// por canal e podia gerar envio duplicado.
//
// defaultMaxInFlight (agendador do cron): teto por número para canais SEM
// linha em dispatch_channel_limits. Diferente de 4 usa
// claim_dispatch_item_capped (migration 164), que só troca esse padrão;
// sem a migration, cai no claim_dispatch_item (teto 4 no banco).
let cappedClaimUnavailable = false;

function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

async function claimItemAtomically(itemId: string, defaultMaxInFlight?: number): Promise<boolean> {
  if (
    defaultMaxInFlight !== undefined &&
    defaultMaxInFlight !== DB_DEFAULT_MAX_IN_FLIGHT &&
    !cappedClaimUnavailable
  ) {
    const { data, error } = await supabaseAdmin().rpc("claim_dispatch_item_capped", {
      p_item_id: itemId,
      p_default_max_in_flight: defaultMaxInFlight,
    });
    if (!error) return data === true;
    if (!isMissingFunction(error)) throw error;
    cappedClaimUnavailable = true;
    console.warn(
      "[Disparador] claim_dispatch_item_capped indisponível (migration 164 não aplicada); usando o teto padrão do banco (4 por número)."
    );
  }
  const { data, error } = await supabaseAdmin().rpc("claim_dispatch_item", {
    p_item_id: itemId,
  });
  if (error) throw error;
  return data === true;
}

/** Observação de uma chamada ao provedor (telemetria/backoff do cron). */
export interface ProviderCallObservation {
  provider: "meta" | "waha";
  latencyMs: number;
  ok: boolean;
  /** Sinal para desacelerar o número (limite/5xx/timeout/rede). */
  signal: BackoffReason | null;
  /** Ex.: "meta:131056", "waha:503", "timeout"; null quando ok. */
  code: string | null;
}

export interface ProcessQueueItemOptions {
  /** Teto por número quando o canal não tem linha em dispatch_channel_limits. */
  defaultMaxInFlight?: number;
  /**
   * Linha de whatsapp_config carregada uma vez no tick (cron), já filtrada
   * pela conta da campanha: null = canal não encontrado para a conta;
   * undefined = não carregada (consulta por envio, como antes).
   */
  channelConfig?: Record<string, any> | null;
  /** Blacklist revalidada uma vez no tick (tick-preload.ts); undefined = consultar. */
  blacklistLookup?: BlacklistLookup;
  /** Só observa: nunca altera o destino do item. */
  onProviderCall?: (observation: ProviderCallObservation) => void;
}

function observe(options: ProcessQueueItemOptions | undefined, observation: ProviderCallObservation) {
  if (!options?.onProviderCall) return;
  try {
    options.onProviderCall(observation);
  } catch (error) {
    console.error("[Disparador] Observador do envio falhou:", error);
  }
}

// Busca o próximo item agendado de uma campanha e o reivindica com o mesmo
// claim protegido usado pelo cron. Pode retornar null sob concorrência
// (outro consumidor venceu) ou quando a quota/concorrência do canal está
// cheia — quem chama apenas tenta de novo no próximo ciclo.
export async function claimQueueItem(campaignId: string): Promise<QueueItem | null> {
  const supabase = supabaseAdmin();

  const now = new Date().toISOString();
  const { data: candidates } = await supabase
    .from("disp_message_queue")
    .select("*")
    .eq("campaign_id", campaignId)
    .eq("status", "agendado")
    .lte("scheduled_at", now)
    .order("scheduled_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1);

  const candidate = candidates?.[0];
  if (!candidate) return null;

  const claimed = await claimItemAtomically(candidate.id);
  return claimed ? ({ ...candidate, status: "enviando" } as QueueItem) : null;
}

// Códigos Meta que indicam número inválido ou sem WhatsApp — não adianta
// retentar o mesmo número, deve ir direto para a escada de número
// alternativo (feature ainda não implementada — ver contact_phones,
// migration 077). 131030/131045: número inválido/não registrado.
// 131021: remetente e destinatário são o mesmo número.
// 131047 (janela de 24h fechada) NÃO é número inválido: o telefone é bom,
// só não aceita texto livre agora — ver META_PERMANENT_CODES. Antes ele
// marcava contact_phones como 'invalido' e pulava para TELEFONE2/3.
const META_INVALID_PHONE_CODES = new Set([131030, 131045, 131021]);

// Códigos Meta que são permanentes mas NÃO são "número inválido" (ex:
// conta suspensa, parâmetro inválido, token expirado/inválido) — sem
// escada de número, é erro final direto.
// 131008: Required parameter is missing — variável obrigatória do
// template está vazia. Não adianta retentar (o parâmetro continuará
// vazio nas próximas tentativas). Marcar como permanente imediatamente.
// 131009: Parameter value is invalid — mesmo raciocínio do 131008, o
// valor continuará inválido em qualquer retry.
// 132000: Number of parameters does not match the expected number of
// params — template inativo/não aprovado ou template_variable_map
// desalinhado; retry não corrige.
// 132001: Template name/language does not exist — parâmetros do
// template incompatíveis com o que está aprovado na Meta; retry não
// corrige.
// 131026: a ocorrência é permanente para ESTA campanha, mas o número só
// entra na blacklist global depois de falhar em 3 campanhas distintas.
// Repetir automaticamente dentro da mesma campanha não cria evidência nova.
// 131047: mensagem fora da janela de 24h — retentar texto livre não muda
// nada; precisa de template.
const META_PERMANENT_CODES = new Set([131026, 131031, 131047, 131051, 368, 190, 131008, 131009, 132000, 132001]);

// Antes da MetaApiError (ver meta-api.ts), a única forma de detectar
// permanência era procurar um código HTTP tipo "4XX" solto na mensagem —
// funciona para erros da WAHA (`WAHA sendText failed (404): ...`), mas
// nunca batia com o formato de erro da Meta (`(#131047) ...`, um código
// de 6 dígitos, não um status HTTP de 3). Isso fazia todo erro de "número
// sem WhatsApp" da Meta retentar até MAX_TENTATIVAS antes de virar
// permanente. Agora usa err.metaCode (estruturado) quando disponível.
function isPermanentSendError(err: unknown): boolean {
  if (err instanceof PreSendError) return true;
  if (err instanceof MetaApiError) {
    if (err.metaCode === null) return false;
    return META_INVALID_PHONE_CODES.has(err.metaCode) || META_PERMANENT_CODES.has(err.metaCode);
  }
  const message = err instanceof Error ? err.message : String(err);
  // Ligação recusada/encerrada/não atendida: não religar automaticamente
  // (antes o retry ligava de novo após 1, 4, 9 e 16 min).
  if (/^Chamada (rejeitada|não atendida)/.test(message)) return true;
  // WAHA: só 400 (requisição inválida) é permanente. 401/403/404/422
  // aparecem com a sessão caída/reiniciando (QR, STARTING) — retry com
  // backoff em vez de condenar a base inteira por uma queda de minutos.
  const waha = message.match(/^WAHA \w+ failed \((\d{3})\)/);
  if (waha) return Number(waha[1]) === 400;
  const wacalls = message.match(/^Failed to start WaCalls call: (\d{3})/);
  if (wacalls) return Number(wacalls[1]) === 400;
  return false;
}

/**
 * Falha ANTES de falar com o provedor (canal sem token, item sem mídia,
 * tipo não suportado…): nada foi enviado, então é erro comum — não fica
 * "aguardando reconciliação".
 */
export class PreSendError extends Error {}

function decryptOrPreSend(value: string, what: string): string {
  try {
    // Mesmo comportamento dos demais caminhos de envio do CRM: GCM/CBC
    // são decifrados e valores legados em texto puro continuam válidos
    // até serem recifrados. O Disparador era a exceção e falhava antes
    // de chamar WAHA/Meta quando encontrava um segredo legado.
    return decryptStoredSecret(value, what);
  } catch {
    throw new PreSendError(`Não foi possível ler a ${what} do canal (reconecte o canal)`);
  }
}

/**
 * O provedor REJEITOU o envio (nada chegou ao cliente)? true = pode marcar
 * erro (e retentar se transitório). false = resultado desconhecido
 * (timeout, rede, 5xx): o item fica 'enviando' para reconciliação, sem
 * segundo POST.
 *
 * Antes todo erro que não fosse MetaApiError 4xx caía em "desconhecido" —
 * inclusive WAHA 4xx e falhas de configuração. Esses itens ficavam presos
 * em 'enviando' para sempre: a campanha nunca encerrava e o canal contava
 * cada um no max_in_flight, travando o número para todas as campanhas.
 */
export function isDefinitiveRejection(err: unknown): boolean {
  if (err instanceof PreSendError) return true;
  if (err instanceof MetaApiError) return err.httpStatus > 0 && err.httpStatus < 500;
  const message = err instanceof Error ? err.message : String(err);
  const waha = message.match(/^WAHA \w+ failed \((\d{3})\)/);
  const wacalls = message.match(/^Failed to start WaCalls call: (\d{3})/);
  const httpStatus = waha ? Number(waha[1]) : wacalls ? Number(wacalls[1]) : null;
  if (httpStatus !== null) {
    // 408 (timeout do lado deles) pode ter enviado; 4xx restantes não.
    return httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408;
  }
  // Ligação recusada/não atendida: concluída, sem nada pendente. "CallID
  // ausente" fica de fora: a chamada pode ter sido iniciada.
  if (/^Chamada (rejeitada|não atendida)/.test(message)) return true;
  return false;
}

// Exportada para a escada de número alternativo (próxima etapa) decidir
// se deve tentar o próximo telefone de wacrm.contact_phones em vez de só
// marcar o item como erro permanente.
export function isInvalidPhoneError(err: unknown): boolean {
  return (
    err instanceof MetaApiError &&
    err.metaCode !== null &&
    META_INVALID_PHONE_CODES.has(err.metaCode)
  );
}

// Grava erro + tentativas no item. Tenta incluir erro_permanente; se a
// coluna ainda não existir (migration 075 não aplicada), regrava sem ela
// para não perder o registro do erro. Quando permanent=true, também
// incrementa campaign_metrics.total_erros — antes desta correção, erros
// síncronos (falha imediata do POST /messages, número esgotou tentativas,
// etc.) nunca incrementavam esse contador; só o webhook assíncrono de
// status "failed" da Meta fazia isso, deixando total_erros sistematicamente
// subcontado pra qualquer falha síncrona ou de WAHA.
//
// Exportada para o catch externo do Promise.all em cron/route.ts (exceções
// lançadas de partes de processQueueItem fora do try/catch interno de
// envio — ex: claimItemAtomically, o throw de "Canal não encontrado") usar
// o mesmo caminho em vez de um UPDATE manual que não setava
// erro_permanente nem incrementava total_erros.
export async function markQueueError(
  itemId: string,
  message: string,
  permanent: boolean,
  campaignId: string,
  tentativas?: number
): Promise<void> {
  const baseUpdate: Record<string, unknown> = { status: "erro", erro: message };
  if (tentativas !== undefined) baseUpdate.tentativas = tentativas;

  const { error } = await supabaseAdmin()
    .from("disp_message_queue")
    .update({ ...baseUpdate, erro_permanente: permanent })
    .eq("id", itemId);

  if (error) {
    await supabaseAdmin().from("disp_message_queue").update(baseUpdate).eq("id", itemId);
  }

  if (permanent) {
    const { error: metricError } = await supabaseAdmin().rpc("increment_campaign_metric", {
      p_campaign_id: campaignId,
      p_field: "total_erros",
    });
    if (metricError) {
      console.error(
        "[Disparador] markQueueError: falha ao incrementar total_erros:",
        metricError.message
      );
    }
  }
}

// TELEFONE1 vive em contacts.phone (ordem 1, implícito); TELEFONE2/3 ficam
// em wacrm.contact_phones com ordem 2/3 — ver migration 077.
const MAX_PHONE_ATTEMPTS = 3;

// Marca em wacrm.contact_phones (migration 086) o telefone que acabou de
// falhar com erro permanente de número inválido — o QUE JÁ FOI TENTADO
// (item.phone_attempt_order atual), não o próximo da escada. Fire-and-
// forget: chamado sem await pelo caller, nunca deve atrasar/derrubar o
// fluxo de envio/retry.
//
// ordem > 1: o telefone já está em contact_phones, atualiza direto por
// (contact_id, ordem) — não precisa nem saber o número em si.
// ordem === 1 (TELEFONE1/contacts.phone): não existe linha em
// contact_phones pra essa combinação por design, então busca o
// phone_normalized de contacts e tenta casar por ele — se não achar
// nada (o caso normal), o UPDATE só não afeta nenhuma linha.
async function markPhoneInvalid(item: QueueItem): Promise<void> {
  if (!item.contact_id) return;
  const attemptOrder = item.phone_attempt_order ?? 1;

  try {
    let error;
    if (attemptOrder > 1) {
      ({ error } = await supabaseAdmin()
        .from("contact_phones")
        .update({
          status: "invalido",
          last_attempt_at: new Date().toISOString(),
        })
        .eq("contact_id", item.contact_id)
        .eq("ordem", attemptOrder));
    } else {
      const { data: contact } = await supabaseAdmin()
        .from("contacts")
        .select("phone_normalized")
        .eq("id", item.contact_id)
        .maybeSingle();
      if (!contact?.phone_normalized) return;

      ({ error } = await supabaseAdmin()
        .from("contact_phones")
        .update({
          status: "invalido",
          last_attempt_at: new Date().toISOString(),
        })
        .eq("contact_id", item.contact_id)
        .eq("phone_normalized", contact.phone_normalized));
    }

    if (error) throw error;
  } catch (err: any) {
    console.error("[Disparador] markPhoneInvalid: falha ao atualizar contact_phones:", err);
    void writeLog({
      level: "warn",
      source: "disparador",
      event: "contact_phone_mark_invalid_failed",
      message: "Falha ao marcar telefone como inválido em contact_phones",
      payload: {
        campaign_id: item.campaign_id,
        contact_id: item.contact_id,
        phone_attempt_order: attemptOrder,
        erro: err?.message || String(err),
      },
    });
  }
}

// Quando o envio falha com um erro de "número inválido/sem WhatsApp" da
// Meta (ver isInvalidPhoneError), tenta escalar para o próximo telefone
// alternativo do contato em wacrm.contact_phones. Reagenda o MESMO item
// de fila com phone_attempt_order incrementado em vez de criar uma linha
// nova — a resolução de qual telefone usar no reenvio é feita em
// processQueueItem a partir desse campo (ver abaixo).
//
// Pula números que já estão na blacklist em vez de desistir da escada
// inteira no primeiro bloqueado — segue tentando até achar um número
// livre ou esgotar MAX_PHONE_ATTEMPTS.
//
// Retorna true se conseguiu reagendar com um próximo número; false se
// não há contact_id, não há mais números na escada, ou o reagendamento
// falhou (erro de banco).
async function tryNextPhone(item: QueueItem): Promise<boolean> {
  if (!item.contact_id) return false;

  let nextOrder = (item.phone_attempt_order ?? 1) + 1;

  while (nextOrder <= MAX_PHONE_ATTEMPTS) {
    const { data: nextPhone } = await supabaseAdmin()
      .from("contact_phones")
      .select("phone")
      .eq("contact_id", item.contact_id)
      .eq("ordem", nextOrder)
      .maybeSingle();

    if (!nextPhone) {
      nextOrder++;
      continue;
    }

    // Mesmo campo (telefone, não phone_normalized) usado pela checagem
    // de blacklist em processQueueItem, pra bater com o formato real
    // gravado em wacrm.blacklist.telefone.
    const { data: blacklistHits } = await supabaseAdmin()
      .from("blacklist")
      .select("id")
      .in("telefone", phoneVariants(nextPhone.phone))
      .limit(1);

    if (blacklistHits?.length) {
      nextOrder++;
      continue;
    }

    const { error } = await supabaseAdmin()
      .from("disp_message_queue")
      .update({
        status: "agendado",
        phone_attempt_order: nextOrder,
        scheduled_at: new Date().toISOString(),
        erro: null,
        erro_permanente: false,
      })
      .eq("id", item.id);

    if (error) {
      console.error("[Disparador] tryNextPhone: falha ao reagendar item:", error.message);
      void writeLog({
        level: "info",
        source: "disparador",
        event: "phone_fallback",
        message: "Falha ao reagendar item da fila para o próximo telefone da escada",
        payload: { campaign_id: item.campaign_id, contact_id: item.contact_id },
      });
      return false;
    }
    return true;
  }

  return false;
}

// Mantida pelo nome para os chamadores existentes; a regra está em
// send-window.ts (fuso de Brasília, janela que cruza a meia-noite).
export function checkWithinWindow(inicio: string, fim: string): boolean {
  return isWithinSendWindow(inicio, fim);
}

export async function processQueueItem(
  item: QueueItem,
  campaign: Campaign,
  options?: ProcessQueueItemOptions
): Promise<ProcessResult> {
  const janela = { inicio: campaign.janela_inicio, fim: campaign.janela_fim, dias: campaign.dias_envio };
  const withinWindow = canSendNow(janela);

  // Campanha em lote/"Segmentado" com rodadas vencidas em período fechado:
  // o cron redistribui a fila inteira antes de enviar (queue-reflow.ts) —
  // não há mais adiamento item a item aqui (ele empurrava filas antigas
  // por dias e invertia a ordem). O adiamento abaixo, para a próxima
  // abertura, é o último recurso para qualquer modo.
  if (!withinWindow) {
    // Fora da janela ou em dia não permitido: adia para a PRÓXIMA abertura
    // válida (hoje, se ainda não abriu; senão o próximo dia permitido).
    const tomorrowUtc = nextSendSlot(janela);

    await supabaseAdmin()
      .from("disp_message_queue")
      .update({ status: "agendado", scheduled_at: tomorrowUtc.toISOString() })
      .eq("id", item.id)
      .eq("status", "agendado");

    return { outcome: "deferred", reason: "outside_window" };
  }

  const claimed = await claimItemAtomically(item.id, options?.defaultMaxInFlight);
  if (!claimed) {
    // Outro consumidor (worker.ts / cron) já reivindicou este item entre
    // o SELECT do chamador e esta chamada — não reprocessa.
    return { outcome: "deferred", reason: "already_claimed" };
  }

  const tentativasAtuais = item.tentativas ?? 0;
  if (tentativasAtuais >= MAX_TENTATIVAS) {
    await markQueueError(
      item.id,
      "Máximo de tentativas atingido",
      true,
      item.campaign_id,
      tentativasAtuais
    );
    return { outcome: "error", error: "Máximo de tentativas atingido" };
  }

  // Para contatos externos (via API), contact_id é null e o
  // telefone está em mensagem_final diretamente. Para contatos reais,
  // phone_attempt_order > 1 (setado por tryNextPhone após um erro de
  // número inválido) indica que a tentativa atual é com um telefone
  // alternativo de wacrm.contact_phones, não o contacts.phone principal.
  let phone: string;
  if (item.contact_id && (item.phone_attempt_order ?? 1) > 1) {
    const { data: altPhone } = await supabaseAdmin()
      .from("contact_phones")
      .select("phone")
      .eq("contact_id", item.contact_id)
      .eq("ordem", item.phone_attempt_order ?? 1)
      .maybeSingle();
    // Contato do CRM: mensagem_final é texto, nunca telefone.
    phone = altPhone?.phone || item.contacts?.phone || "";
  } else {
    // Mesma regra que o cron usa para pré-carregar a blacklist.
    // Só itens externos (contact_id nulo, API v1) guardam o número em mensagem_final.
    phone = queueItemPrimaryPhone(item) ?? (item.contact_id ? "" : item.mensagem_final);
  }
  if (item.contact_id && !hasDialablePhone(phone)) {
    await markQueueError(item.id, NO_VALID_PHONE_ERROR, true, item.campaign_id, tentativasAtuais + 1);
    return { outcome: "error", error: NO_VALID_PHONE_ERROR };
  }

  // Revalidação do tick (cron): mesma chave do startCampaign, que também
  // cobre as variações abaixo. Sem ela (telefone alternativo, RPC ausente,
  // worker), consulta por envio.
  let blacklisted = options?.blacklistLookup?.(phone);
  if (blacklisted === undefined) {
    // Variações do número (com/sem 55, com/sem 9º dígito): entradas antigas
    // da blacklist gravadas em outro formato também bloqueiam.
    const { data: blacklistRows, error: blacklistCheckError } = await supabaseAdmin()
      .from("blacklist")
      .select("id")
      .in("telefone", phoneVariants(phone))
      .limit(1);

    if (blacklistCheckError) {
      // Falha fechada: antes, um erro transitório aqui deixava `blacklisted`
      // undefined e o código seguia como "não bloqueado", enviando a
      // mensagem mesmo sem conseguir confirmar que o número não está na
      // blacklist. permanent=false — é um erro técnico da checagem, não
      // uma rejeição de negócio; deixa retry_transient_queue_errors tentar
      // de novo no próximo tick em vez de desistir permanentemente.
      await markQueueError(
        item.id,
        `Falha ao checar blacklist: ${blacklistCheckError.message}`,
        false,
        item.campaign_id,
        tentativasAtuais + 1
      );
      return { outcome: "error", error: blacklistCheckError.message };
    }
    blacklisted = (blacklistRows?.length ?? 0) > 0;
  }

  if (blacklisted) {
    await supabaseAdmin()
      .from("disp_message_queue")
      .update({ status: "bloqueado", erro: "Número na Blacklist" })
      .eq("id", item.id);
    // Antes desta correção, nada incrementava total_blacklist —
    // campaign_metrics nunca refletia quantos itens foram bloqueados.
    const { error: metricError } = await supabaseAdmin().rpc("increment_campaign_metric", {
      p_campaign_id: item.campaign_id,
      p_field: "total_blacklist",
    });
    if (metricError) {
      console.error(
        "[Disparador] processQueueItem: falha ao incrementar total_blacklist:",
        metricError.message
      );
    }
    return { outcome: "blocked", reason: "blacklisted" };
  }

  // Canal sempre da conta da campanha (quando conhecida): session_ids vêm
  // do cliente e antes bastava um UUID de outra conta para disparar por ela.
  // O cron já traz a linha (uma leitura por tick, mesmo filtro de conta).
  let config: Record<string, any> | null;
  if (options?.channelConfig !== undefined) {
    config = options.channelConfig;
  } else {
    let configQuery = supabaseAdmin()
      .from("whatsapp_config")
      .select("*")
      .eq("id", item.session_id);
    if (campaign.account_id) configQuery = configQuery.eq("account_id", campaign.account_id);
    const { data, error: configError } = await configQuery.maybeSingle();

    if (configError) {
      // Falha momentânea do banco: retry, não condena o contato.
      const message = `Falha ao carregar o canal: ${configError.message}`;
      await markQueueError(item.id, message, false, item.campaign_id, tentativasAtuais + 1);
      return { outcome: "error", error: message };
    }
    config = data;
  }
  if (!config) {
    // O item já foi reivindicado ('enviando'): sem canal nada foi enviado,
    // então fecha como erro em vez de deixá-lo preso.
    const message = `Canal não encontrado para esta conta (session_id: ${item.session_id})`;
    await markQueueError(item.id, message, true, item.campaign_id, tentativasAtuais + 1);
    return { outcome: "error", error: message };
  }

  const provider = config.provider as "waha" | "meta";
  // Bucket chat-media é privado: troca a referência interna por URL
  // assinada curta que Meta/WAHA conseguem baixar. Valida que o anexo
  // pertence à conta do canal.
  if (item.media_url) {
    try {
      item = { ...item, media_url: await resolveProviderMedia(item.media_url, config.account_id) };
    } catch (mediaErr) {
      const detail = mediaErr instanceof Error ? mediaErr.message : String(mediaErr);
      const message = `Mídia indisponível: ${detail}`;
      // Anexo de outra conta é definitivo; falha ao assinar a URL, não.
      await markQueueError(item.id, message, /não autorizado/i.test(detail), item.campaign_id, tentativasAtuais + 1);
      return { outcome: "error", error: message };
    }
  }
  const tipo = item.tipo || "texto";
  // Contato externo com texto livre WAHA: mensagem_final guarda o
  // telefone (única forma de resolvê-lo sem contact_id), o texto real
  // fica em template_variables[0].
  let messageText =
    item.template_name === EXTERNAL_WAHA_TEXT_MARKER
      ? (item.template_variables?.[0] ?? "")
      : item.mensagem_final;

  if (tipo === "ia") {
    // Campanha com IA: mensagem_final é o PROMPT. Falha da IA (429/timeout/sem chave/vazio) NUNCA
    // pode enviar o prompt ao cliente: o item volta para a fila (erro retentável, sem consumir
    // tentativa) e a pausa automática conta estas ocorrências.
    const generated = await generateDispatchAiText(messageText, item.contacts?.name);
    if (generated === null) {
      await markQueueError(item.id, AI_UNAVAILABLE_ERROR, false, item.campaign_id, tentativasAtuais);
      void writeLog({
        level: "warn",
        source: "disparador",
        event: "message_ai_unavailable",
        message: "Geração por IA indisponível; item devolvido à fila sem enviar nada ao cliente",
        payload: { campaign_id: item.campaign_id, queue_id: item.id },
      });
      return { outcome: "deferred", reason: "ai_unavailable" };
    }
    messageText = generated;
  }

  const cleanText = applyTemplateVars(messageText, item.contacts).replace(
    /{nome}/g,
    item.contacts?.name || "Cliente"
  );
  const normalizedPhone = phone.replace("+", "");

  let externalMessageId: string;
  const providerStartedAt = Date.now();
  try {
    externalMessageId =
      provider === "meta"
        ? await sendViaMeta(config, item, normalizedPhone, cleanText, tipo)
        : await sendViaWaha(config, item, normalizedPhone, cleanText, tipo);
    observe(options, { provider, latencyMs: Date.now() - providerStartedAt, ok: true, signal: null, code: null });
  } catch (sendErr: any) {
    // Falha antes de falar com o provedor não entra na latência nem no
    // backoff do número.
    if (!(sendErr instanceof PreSendError)) {
      const { reason, code } = classifyProviderError(sendErr);
      observe(options, { provider, latencyMs: Date.now() - providerStartedAt, ok: false, signal: reason, code });
    }
    // Timeout, erro de rede ou 5xx não provam se o POST foi aceito.
    // Deixar isso em enviando consome max_in_flight e pode paralisar o
    // número inteiro. Também não podemos reenviar, pois pode duplicar.
    // Resultado: terminaliza como erro permanente sem retry e libera a vaga.
    // Exceção: falha de CONEXÃO (ECONNREFUSED/ENOTFOUND/EAI_AGAIN/connect timeout) prova que o POST
    // não saiu — transitório com retry normal (decisão do dono, P0-3).
    if (isNotConnectedError(sendErr)) {
      await markQueueError(item.id, NOT_CONNECTED_ERROR, false, item.campaign_id, tentativasAtuais + 1);
      return { outcome: "error", error: NOT_CONNECTED_ERROR };
    }
    if (!isDefinitiveRejection(sendErr)) {
      // 502/503/504 e timeout de resposta: pode ter saído. Não reenvia; o auto-pause conta estes
      // "incertos" (UNCERTAIN_OUTCOME_ERROR) para frear a campanha quando viram um padrão.
      const message = UNCERTAIN_OUTCOME_ERROR;
      await markQueueError(
        item.id,
        message,
        true,
        item.campaign_id,
        tentativasAtuais + 1,
      );
      return { outcome: "error", error: message };
    }
    if (sendErr instanceof MetaApiError) {
      console.error(
        `[Disparador] Meta error code: ${sendErr.metaCode}, http: ${sendErr.httpStatus}`
      );

      // 131026 encerra esta tentativa sem retry automático, mas só vira
      // blacklist definitiva quando ocorrer em 3 CAMPANHAS DISTINTAS.
      if (sendErr.metaCode === 131026) {
        const novasTentativas = tentativasAtuais + 1;
        const message = sendErr?.message || String(sendErr);
        const strike = await autoBlacklistOn131026(
          phone,
          item.campaign_id ?? null,
        );

        if (!strike.blacklisted) {
          await markQueueError(
            item.id,
            message,
            true,
            item.campaign_id,
            novasTentativas,
          );
          void writeLog({
            level: "warn",
            source: "disparador",
            event: "message_meta_131026_strike",
            message: "Meta 131026 registrado; número ainda não entrou na blacklist definitiva",
            payload: {
              campaign_id: item.campaign_id,
              contact_id: item.contact_id,
              phone: maskPhone(normalizedPhone),
              metaCode: 131026,
              campaign_count: strike.campaignCount,
              threshold: 3,
            },
          });
          return { outcome: "error", error: message };
        }

        const { error: blockError } = await supabaseAdmin()
          .from("disp_message_queue")
          .update({
            status: "bloqueado",
            erro: message,
            erro_permanente: true,
            tentativas: novasTentativas,
          })
          .eq("id", item.id);

        if (blockError) {
          await markQueueError(
            item.id,
            message,
            true,
            item.campaign_id,
            novasTentativas,
          );
          return { outcome: "error", error: message };
        }

        const { error: metricError } = await supabaseAdmin().rpc(
          "increment_campaign_metric",
          {
            p_campaign_id: item.campaign_id,
            p_field: "total_blacklist",
          },
        );
        if (metricError) {
          console.error(
            "[Disparador] Falha ao incrementar total_blacklist após 131026:",
            metricError.message,
          );
        }

        void writeLog({
          level: "warn",
          source: "disparador",
          event: "message_blocked_meta_131026",
          message: "Destino bloqueado definitivamente após 131026 em 3 campanhas distintas",
          payload: {
            campaign_id: item.campaign_id,
            contact_id: item.contact_id,
            phone: maskPhone(normalizedPhone),
            metaCode: 131026,
            campaign_count: strike.campaignCount,
          },
        });

        return { outcome: "blocked", reason: "meta_131026_threshold" };
      }
    }

    if (isInvalidPhoneError(sendErr)) {
      // Fire-and-forget — marca o telefone que acabou de falhar, não
      // bloqueia a escalada pro próximo da escada logo abaixo.
      void markPhoneInvalid(item);
      const escalated = await tryNextPhone(item);
      if (escalated) {
        // Item reagendado com o próximo telefone da escada — não é um
        // erro final, só adia pro próximo ciclo do worker/cron.
        return { outcome: "deferred", reason: "retrying_alternate_phone" };
      }
      // Sem mais números na escada — cai para o markQueueError abaixo,
      // que já marca permanent=true nesse caso (isPermanentSendError
      // também cobre os mesmos códigos de META_INVALID_PHONE_CODES).
    }

    const novasTentativas = tentativasAtuais + 1;
    const permanent = isPermanentSendError(sendErr) || novasTentativas >= MAX_TENTATIVAS;
    const message = sendErr?.message || String(sendErr);
    if (isPermanentSendError(sendErr)) {
      void writeLog({
        level: "warn",
        source: "disparador",
        event: "message_permanent_error",
        message: "Item da fila marcado como erro permanente — código Meta não retenta",
        payload: {
          campaign_id: item.campaign_id,
          contact_id: item.contact_id,
          phone: maskPhone(normalizedPhone),
          metaCode: sendErr instanceof MetaApiError ? sendErr.metaCode : null,
          erro: message,
        },
      });
    }
    await markQueueError(item.id, message, permanent, item.campaign_id, novasTentativas);
    return { outcome: "error", error: message };
  }

  // Atômico via RPC (migration 091) — antes eram 3 escritas sequenciais
  // sem transação (UPDATE disp_message_queue -> INSERT message_logs ->
  // RPC increment_campaign_metric); um crash/restart entre a 1ª e a 3ª
  // deixava a mensagem marcada 'enviado' mas sem log de auditoria e/ou
  // sem incrementar campaign_metrics.total_enviados, sem reconciliação
  // possível depois.
  const { error: markSentError, replayed } = await confirmItemSent({
    p_item_id: item.id,
    p_campaign_id: item.campaign_id,
    p_contact_id: item.contact_id,
    p_session_id: item.session_id,
    p_mensagem: cleanText,
    p_waha_message_id: externalMessageId,
    p_tentativas: (item.tentativas || 0) + 1,
  });

  if (markSentError) {
    // O provedor JÁ aceitou o envio, mas a confirmação local falhou. Não
    // marcamos erro (isso levaria a reenvio): gravamos o message ID externo
    // no item, que continua 'enviando', para reconciliação posterior via
    // mark_queue_item_sent (idempotente) — sem novo POST ao provedor.
    console.error("[Disparador] Envio aceito; confirmação local pendente:", markSentError.message);
    const { error: receiptError } = await supabaseAdmin()
      .from("disp_message_queue")
      .update({
        waha_message_id: externalMessageId,
        erro: "Envio aceito pelo provedor; confirmação local pendente. Não reenviar.",
      })
      .eq("id", item.id)
      .eq("status", "enviando");
    if (receiptError)
      console.error(
        "[Disparador] Falha ao persistir recibo de envio aceito:",
        receiptError.message
      );
    return {
      outcome: "pending_confirmation",
      messageId: externalMessageId,
      reason: "local_confirmation_failed",
    };
  }

  // O webhook de status (delivered/read/failed) pode chegar antes desta
  // confirmação local; nesse caso ele ficou guardado em
  // dispatch_status_receipts (migration 125). Reaplica agora que o item
  // está 'enviado'. Falha aqui não é crítica: o cron reconcilia depois.
  // Com a migration 167 o replay já rodou dentro da confirmação.
  if (!replayed) {
    const { error: replayError } = await supabaseAdmin().rpc('replay_dispatch_receipts', { p_message_id: externalMessageId });
    if (replayError) console.error('[Disparador] Confirmações antecipadas aguardam reconciliação:', replayError.message);
  }
  return { outcome: "sent", messageId: externalMessageId };
}

// Confirmação local do envio. Com a migration 167, confirm_dispatch_item_sent
// faz mark_queue_item_sent + replay dos recibos antecipados na mesma
// transação (uma ida ao banco a menos por envio). Sem ela, cai no
// mark_queue_item_sent e o replay roda à parte, como antes.
let confirmRpcUnavailable = false;

async function confirmItemSent(
  args: Record<string, unknown>
): Promise<{ error: { message: string } | null; replayed: boolean }> {
  if (!confirmRpcUnavailable) {
    const { error } = await supabaseAdmin().rpc("confirm_dispatch_item_sent", args);
    if (!error) return { error: null, replayed: true };
    if (!isMissingFunction(error)) return { error, replayed: false };
    confirmRpcUnavailable = true;
    console.warn(
      "[Disparador] confirm_dispatch_item_sent indisponível (migration 167 não aplicada); usando mark_queue_item_sent + replay."
    );
  }
  const { error } = await supabaseAdmin().rpc("mark_queue_item_sent", args);
  return { error, replayed: false };
}

async function sendViaWaha(
  config: any,
  item: QueueItem,
  phone: string,
  text: string,
  tipo: string
): Promise<string> {
  const wahaConfig = {
    waha_url: config.waha_url,
    waha_session: config.waha_session,
    waha_api_key: config.waha_api_key ? decryptOrPreSend(config.waha_api_key, "chave da API WAHA") : null,
  };

  // Mesma validação do caminho Meta (sendViaMeta, abaixo) — sem isso,
  // item.media_url! (non-null assertion sem checagem em runtime) deixava
  // passar undefined pro WAHA em silêncio em vez de falhar com uma
  // mensagem clara.
  if (
    (tipo === "imagem" || tipo === "video" || tipo === "audio" || tipo === "arquivo") &&
    !item.media_url
  ) {
    throw new PreSendError(`Item ${item.id} do tipo ${tipo} não tem mídia (media_url)`);
  }

  if (tipo === "imagem") {
    const res = await sendWahaMediaMessage(
      wahaConfig,
      phone,
      item.media_url!,
      "image",
      "imagem.png",
      text
    );
    return res.messageId;
  }
  if (tipo === "video") {
    const res = await sendWahaMediaMessage(
      wahaConfig,
      phone,
      item.media_url!,
      "video",
      "video.mp4",
      text
    );
    return res.messageId;
  }
  if (tipo === "audio") {
    const res = await sendWahaVoiceMessage(wahaConfig, phone, item.media_url!);
    return res.messageId;
  }
  if (tipo === "arquivo") {
    const res = await sendWahaMediaMessage(
      wahaConfig,
      phone,
      item.media_url!,
      "document",
      "documento",
      text
    );
    return res.messageId;
  }
  if (tipo === "ligacao") {
    const { callId } = await startWacallsCall(wahaConfig, phone);
    if (!callId) throw new Error("Não foi possível gerar um CallID para a ligação");

    let isConnected = false;
    let ended = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const callInfo = await getWacallsCallStatus(wahaConfig, callId);
        if (callInfo.status === "connected") {
          isConnected = true;
          break;
        }
        if (callInfo.ended || callInfo.status === "ended") {
          ended = true;
          break;
        }
      } catch (err) {
        console.warn(`[processQueue] Falha ao checar status da ligação ${callId}:`, err);
      }
    }
    if (!isConnected) {
      throw new Error(
        ended
          ? "Chamada rejeitada ou encerrada pelo destinatário"
          : "Chamada não atendida (tempo esgotado)"
      );
    }
    await playWacallsAudio(wahaConfig, callId, item.media_url!);
    return `call_${callId}`;
  }

  const res = await sendWahaTextMessage(wahaConfig, phone, text);
  return res.messageId;
}

async function sendViaMeta(
  config: any,
  item: QueueItem,
  phone: string,
  text: string,
  tipo: string
): Promise<string> {
  if (tipo === "ligacao") {
    throw new PreSendError("Ligação não é suportada em canais Meta (API oficial)");
  }

  const accessToken = config.access_token ? decryptOrPreSend(config.access_token, "token de acesso Meta") : null;
  if (!accessToken) {
    throw new PreSendError(`Canal Meta sem token de acesso configurado (session_id: ${item.session_id})`);
  }
  const phoneNumberId = config.phone_number_id;
  if (!phoneNumberId) {
    throw new PreSendError(`Canal Meta sem phone_number_id configurado (session_id: ${item.session_id})`);
  }

  // Caminho template (business-initiated obrigatório fora da janela 24h)
  if (item.template_name) {
    const variables: string[] = Array.isArray(item.template_variables)
      ? item.template_variables.map(String)
      : [];

    // Sanitiza variáveis — converte Markdown [texto](url) para url pura
    const sanitizedVariables = variables.map((v) => {
      const mdLink = v.match(/\[.*?\]\((https?:\/\/[^)]+)\)/);
      if (mdLink) return mdLink[1];
      // Remove formatação Markdown residual
      return v.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    });

    const result = await sendTemplateMessage({
      phoneNumberId,
      accessToken,
      to: phone,
      templateName: item.template_name,
      language: item.template_language ?? "pt_BR",
      params: sanitizedVariables,
    });
    return result.messageId;
  }

  // Caminho texto livre (só válido dentro da janela 24h — customer-initiated)
  if (tipo === "imagem" || tipo === "video" || tipo === "audio" || tipo === "arquivo") {
    const kindMap: Record<string, "image" | "video" | "audio" | "document"> = {
      imagem: "image",
      video: "video",
      audio: "audio",
      arquivo: "document",
    };
    if (!item.media_url) {
      throw new PreSendError(`Item ${item.id} do tipo ${tipo} não tem mídia (media_url)`);
    }
    const result = await sendMediaMessage({
      phoneNumberId,
      accessToken,
      to: phone,
      kind: kindMap[tipo],
      link: item.media_url,
      caption: text || undefined,
      filename: tipo === "arquivo" ? "documento" : undefined,
    });
    return result.messageId;
  }

  // Texto simples
  const result = await sendTextMessage({
    phoneNumberId,
    accessToken,
    to: phone,
    text,
  });
  return result.messageId;
}

// Dispara um webhook de callback para o sistema externo quando uma
// campanha termina de processar. Nunca lança: qualquer falha (URL
// bloqueada, timeout, erro de rede, HTTP não-2xx) é logada e vira `false`.
//
// Retorno usado pela outbox (callback-outbox.ts):
// - true  → entregue (2xx) ou campanha sem callback_url (nada a fazer);
// - false → tentar de novo depois, com backoff.
// O header `Idempotency-Key: campaign.completed:<id>` é estável entre
// tentativas, para o receptor deduplicar caso um retry repita a entrega.
// `completed_at` usa updated_at da campanha (momento do encerramento), e
// não "agora", para o payload ser idêntico em todas as tentativas.
export async function sendCampaignCallback(campaignId: string): Promise<boolean> {
  try {
    const db = supabaseAdmin();

    // Buscar campanha com callback_url
    const { data: campaign } = await db
      .from("campaigns")
      .select("id, nome, status, callback_url, updated_at")
      .eq("id", campaignId)
      .maybeSingle();

    if (!campaign) return false;
    if (!campaign.callback_url) return true;

    // Revalida a URL no momento do envio (não só na criação da
    // campanha) — fecha a janela entre criar a campanha e o callback
    // disparar dias depois (DNS rebinding / URL editada direto no banco).
    try {
      await assertWahaUrlIsSafe(campaign.callback_url);
    } catch (err) {
      console.error(`[Callback] Campanha ${campaignId} — callback_url bloqueada:`, err);
      return false;
    }

    // Buscar métricas da campanha
    const { data: metrics } = await db
      .from("campaign_metrics")
      .select("*")
      .eq("campaign_id", campaignId)
      .maybeSingle();

    // Resumo da fila por status numa agregação só (get_campaign_stats), em vez de paginar a fila
    // inteira por OFFSET sem ORDER BY (REVISAO F6b/F19). Falha ⇒ a outbox tenta de novo depois.
    const statusCounts = await loadCampaignStatusCounts(db, campaignId);
    if (!statusCounts) return false;
    const { total_enfileirados, enviados, erros, bloqueados, cancelados } = summarizeStatusCounts(statusCounts);

    // Nota: só roda quando a campanha tem callback_url configurado (early
    // return na linha acima) — campanhas sem callback externo não geram
    // este evento hoje. Ver ressalva no PASSO 4 da instrumentação.
    void writeLog({
      level: "info",
      source: "disparador",
      event: "campaign_finished",
      message: `Campanha ${campaign.nome} finalizada`,
      payload: { campaign_id: campaign.id, total_erros: erros },
    });

    const payload = {
      event: "campaign.completed",
      campaign_id: campaign.id,
      campaign_name: campaign.nome,
      completed_at: campaign.updated_at,
      summary: {
        total_enfileirados,
        enviados,
        entregues: metrics?.total_entregues ?? 0,
        lidos: metrics?.total_lidos ?? 0,
        erros,
        bloqueados,
        cancelados,
      },
    };

    const response = await safeFetch(
      campaign.callback_url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `campaign.completed:${campaignId}`,
        },
        body: JSON.stringify(payload),
      },
      { timeoutMs: 10_000, maxBytes: 256 * 1024 },
    );

    if (!response.ok) throw new Error(`Callback rejeitado: HTTP ${response.status}`);

    console.log(
      `[Callback] Campanha ${campaignId} — callback enviado para ${campaign.callback_url}`
    );
    return true;
  } catch (err: any) {
    console.error(`[Callback] Campanha ${campaignId} — falha ao enviar callback:`, err.message);
    return false;
  }
}
