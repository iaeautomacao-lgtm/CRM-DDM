import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { writeLog } from "@/lib/logger";
import { privateChatMediaUrl } from "@/lib/storage/chat-media";
import {
  campaignContentType,
  campaignMessageStatus,
  campaignMessageText,
  matchQueueItemByProviderId,
  type SentQueueItem,
} from "./campaign-message";
import { SENT_QUEUE_COLUMNS, loadLoggedText, loadTemplateBody } from "./campaign-context";

const DAY_MS = 24 * 60 * 60 * 1000;
// Janela do critério "disparo mais recente" (sem citação) — a mesma de antes.
const RECENT_WINDOW_MS = 7 * DAY_MS;
// Janela maior para achar a mensagem citada: o cliente pode responder
// citando um disparo de semanas atrás.
const CONTEXT_WINDOW_MS = 30 * DAY_MS;
const CANDIDATE_LIMIT = 50;

export interface CampaignReplyInput {
  contactId: string;
  accountId: string;
  /** Conversa onde a resposta entrou — é onde a mensagem do disparo aparece. */
  conversationId: string;
  /** Id do provedor da mensagem recebida (messages.message_id). */
  inboundMessageId: string;
  /** Mensagem citada pelo cliente: Meta `context.id` / WAHA `replyTo.id`. */
  replyToProviderId?: string | null;
  /** Telefone normalizado de onde a resposta veio (contact_phones). */
  replyPhoneNormalized?: string;
}

// Quando um contato responde (webhook inbound Meta ou WAHA):
//
// 1. Marca contact_phones.status = 'respondeu' para o telefone usado.
// 2. Descobre a qual disparo a resposta pertence:
//    - 'context': o cliente citou a mensagem da campanha → match exato pelo
//      id do provedor (disp_message_queue.waha_message_id guarda o wamid da
//      Meta e o id do WAHA);
//    - 'recent': sem citação, o disparo mais recente para o contato nos
//      últimos 7 dias (o critério que existia antes).
// 3. Métricas: total_respostas e tempo_medio_resposta contam só a PRIMEIRA
//    resposta de cada envio (disp_message_queue.replied_at, migration 126).
// 4. Conversa: garante que a mensagem do disparo exista em `messages` (o
//    disparador não grava lá; no WAHA o eco fromMe já existe e só é
//    marcado), liga a resposta a ela e grava a campanha de origem da
//    conversa. É isso que permite ao inbox mostrar template + campanha.
//
// Filtra status IN ('enviado', 'entregue', 'lido') porque o item avança na
// escada de status com os recibos da Meta antes de o contato responder.
// Usa `sent_at` (setado no envio e nunca mais alterado), não `updated_at`.
//
// Silencioso em qualquer falha — nunca deve derrubar o webhook que chama.
// Cada etapa tem seu próprio try para uma falha não pular as seguintes.
export async function recordCampaignReply(input: CampaignReplyInput): Promise<void> {
  const { contactId, replyPhoneNormalized } = input;

  // Se o número for contacts.phone (TELEFONE1), não existe linha em
  // contact_phones por design (ver processQueue.ts) — o UPDATE não afeta
  // nada, silenciosamente.
  if (replyPhoneNormalized) {
    try {
      const { error: phoneUpdateError } = await supabaseAdmin()
        .from("contact_phones")
        .update({ status: "respondeu" })
        .eq("contact_id", contactId)
        .eq("phone_normalized", replyPhoneNormalized);

      if (phoneUpdateError) {
        console.error(
          "[recordCampaignReply] falha ao marcar contact_phones como respondeu:",
          phoneUpdateError.message
        );
        void writeLog({
          level: "warn",
          source: "disparador",
          event: "contact_phone_mark_replied_failed",
          message: "Falha ao marcar telefone como respondido em contact_phones",
          payload: { contact_id: contactId, erro: phoneUpdateError.message },
        });
      }
    } catch (err) {
      console.error("[recordCampaignReply] erro inesperado ao marcar contact_phones:", err);
    }
  }

  let attribution: { item: SentQueueItem; method: "context" | "recent" } | null = null;
  try {
    attribution = await resolveCampaignAttribution(input);
  } catch (err) {
    console.error("[recordCampaignReply] erro ao resolver campanha da resposta:", err);
    return;
  }
  if (!attribution) return;

  try {
    await countFirstReply(attribution.item);
  } catch (err) {
    console.error("[recordCampaignReply] erro ao atualizar métricas de resposta:", err);
  }

  try {
    await linkReplyInConversation(input, attribution.item, attribution.method);
  } catch (err) {
    console.error("[recordCampaignReply] erro ao ligar resposta à campanha na conversa:", err);
  }
}

/**
 * A qual disparo esta resposta pertence (ver regras no topo do arquivo).
 * Exportada para a opção "ao responder, enviar para o Webchat" da campanha
 * (src/lib/webchat/campaign.ts) usar exatamente o mesmo critério.
 */
export async function resolveCampaignAttribution(
  input: Pick<CampaignReplyInput, "accountId" | "contactId" | "replyToProviderId">
): Promise<{ item: SentQueueItem; method: "context" | "recent" } | null> {
  const since = new Date(Date.now() - CONTEXT_WINDOW_MS).toISOString();
  // disp_message_queue.account_id existe (migration 040); filtrar por conta
  // é defesa em profundidade além do contact_id já resolvido na conta.
  const { data, error } = await supabaseAdmin()
    .from("disp_message_queue")
    .select(SENT_QUEUE_COLUMNS)
    .eq("account_id", input.accountId)
    .eq("contact_id", input.contactId)
    .in("status", ["enviado", "entregue", "lido"])
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(CANDIDATE_LIMIT);
  if (error) throw error;
  const items = (data ?? []) as SentQueueItem[];
  if (items.length === 0) return null;

  if (input.replyToProviderId) {
    const quoted = matchQueueItemByProviderId(items, input.replyToProviderId);
    if (quoted) return { item: quoted, method: "context" };
  }

  const latest = items[0];
  if (Date.now() - new Date(latest.sent_at).getTime() > RECENT_WINDOW_MS) return null;
  return { item: latest, method: "recent" };
}

async function countFirstReply(item: SentQueueItem): Promise<void> {
  // UPDATE condicional = só a primeira resposta do envio vence, mesmo com
  // duas mensagens do cliente chegando juntas.
  const { data: firstReply, error: repliedError } = await supabaseAdmin()
    .from("disp_message_queue")
    .update({ replied_at: new Date().toISOString() })
    .eq("id", item.id)
    .is("replied_at", null)
    .select("id");

  if (repliedError) {
    // Migration 126 ainda não aplicada (coluna replied_at inexistente):
    // mantém o comportamento antigo de contar toda resposta, em vez de
    // parar de contar até a migration entrar.
    console.error(
      "[recordCampaignReply] replied_at indisponível (migration 126?) — contando sem dedupe:",
      repliedError.message
    );
  } else if (!firstReply?.length) {
    return; // envio já tinha sido respondido antes: não conta de novo
  }

  const { error: rpcError } = await supabaseAdmin().rpc("increment_campaign_metric", {
    p_campaign_id: item.campaign_id,
    p_field: "total_respostas",
  });
  if (rpcError) {
    console.error("[recordCampaignReply] falha ao incrementar total_respostas:", rpcError.message);
    return;
  }

  // Tempo médio de resposta — média móvel em segundos. Lê total_respostas
  // DEPOIS do increment acima (n já inclui esta resposta) para ponderar a
  // média anterior pelas n-1 amostras que a compuseram.
  const elapsed = Math.round((Date.now() - new Date(item.sent_at).getTime()) / 1000);
  if (elapsed <= 0) return; // sent_at no futuro ou igual a agora — dado inválido

  const { data: metricsRows, error: metricsError } = await supabaseAdmin()
    .from("campaign_metrics")
    .select("total_respostas, tempo_medio_resposta")
    .eq("campaign_id", item.campaign_id)
    .limit(1);
  if (metricsError) {
    console.error("[recordCampaignReply] falha ao buscar campaign_metrics:", metricsError.message);
    return;
  }
  const metrics = metricsRows?.[0];
  const n = metrics?.total_respostas ?? 1;
  const mediaAtual = metrics?.tempo_medio_resposta ?? 0;
  const novaMedia = n <= 1 ? elapsed : Math.round((mediaAtual * (n - 1) + elapsed) / n);

  const { error: updateError } = await supabaseAdmin()
    .from("campaign_metrics")
    .update({ tempo_medio_resposta: novaMedia })
    .eq("campaign_id", item.campaign_id);
  if (updateError) {
    console.error(
      "[recordCampaignReply] falha ao atualizar tempo_medio_resposta:",
      updateError.message
    );
  }
}

async function linkReplyInConversation(
  input: CampaignReplyInput,
  item: SentQueueItem,
  method: "context" | "recent"
): Promise<void> {
  const db = supabaseAdmin();
  const campaignMessageId = await ensureCampaignMessage(
    input.conversationId,
    input.accountId,
    item
  );

  // Resposta: campanha, envio e como foi atribuída.
  const { error: replyError } = await db
    .from("messages")
    .update({ campaign_id: item.campaign_id, queue_item_id: item.id, attribution_method: method })
    .eq("conversation_id", input.conversationId)
    .eq("message_id", input.inboundMessageId);
  if (replyError) {
    console.error(
      "[recordCampaignReply] falha ao marcar resposta (migration 126?):",
      replyError.message
    );
    return;
  }

  // reply_to_message_id só quando o cliente citou o disparo e o webhook não
  // achou o pai (a mensagem da campanha ainda não existia em `messages`
  // quando a resposta foi gravada).
  if (method === "context" && campaignMessageId) {
    const { error: parentError } = await db
      .from("messages")
      .update({ reply_to_message_id: campaignMessageId })
      .eq("conversation_id", input.conversationId)
      .eq("message_id", input.inboundMessageId)
      .is("reply_to_message_id", null);
    if (parentError) {
      console.error("[recordCampaignReply] falha ao ligar citação:", parentError.message);
    }
  }

  // Campanha de origem da conversa: só a primeira (não sobrescreve).
  const { error: convError } = await db
    .from("conversations")
    .update({ origin_campaign_id: item.campaign_id, origin_queue_item_id: item.id })
    .eq("id", input.conversationId)
    .eq("account_id", input.accountId)
    .is("origin_campaign_id", null);
  if (convError) {
    console.error("[recordCampaignReply] falha ao gravar origem da conversa:", convError.message);
  }
}

/**
 * Garante que a mensagem do disparo esteja em `messages` nesta conversa e
 * devolve seu id interno.
 *
 * - WAHA: o eco `fromMe` do envio já foi gravado pelo webhook (mesmo
 *   message_id) → só marca campanha/envio nele.
 * - Meta: não há eco → insere a mensagem com o texto que o cliente recebeu,
 *   `created_at = sent_at` (fica antes da resposta na conversa).
 *
 * Feito só quando o cliente responde, para não gravar uma mensagem por
 * contato que nunca respondeu.
 */
async function ensureCampaignMessage(
  conversationId: string,
  accountId: string,
  item: SentQueueItem
): Promise<string | null> {
  if (!item.waha_message_id) return null;
  const db = supabaseAdmin();

  const existing = await findMessageByProviderId(item.waha_message_id);
  if (existing) {
    if (existing.conversation_id === conversationId) {
      const { error } = await db
        .from("messages")
        .update({ campaign_id: item.campaign_id, queue_item_id: item.id })
        .eq("id", existing.id)
        .is("campaign_id", null);
      if (error) console.error("[recordCampaignReply] falha ao marcar eco do disparo:", error.message);
      return existing.id;
    }
    // Já está em outra conversa do contato (ex.: conversa antiga fechada).
    // Não duplica — o índice único de message_id (migration 088) nem deixaria.
    return null;
  }

  const [templateBody, loggedText] = await Promise.all([
    loadTemplateBody(item, accountId),
    loadLoggedText(item.id),
  ]);
  const contentType = campaignContentType(item);
  const { data: inserted, error } = await db
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_type: "bot",
      content_type: contentType,
      content_text: campaignMessageText(item, { templateBody, loggedText }),
      media_url:
        item.media_url && contentType !== "text" && contentType !== "template"
          ? privateChatMediaUrl(item.media_url)
          : null,
      template_name: contentType === "template" ? item.template_name : null,
      message_id: item.waha_message_id,
      status: campaignMessageStatus(item.status),
      created_at: item.sent_at,
      // Historical campaign messages are reconstructed only when the
      // customer replies. Keep BOTH timestamps at the original send time;
      // leaving received_at at its DB default (now()) makes the old template
      // jump into the middle of the live conversation and can race with AI.
      received_at: item.sent_at,
      campaign_id: item.campaign_id,
      queue_item_id: item.id,
    })
    .select("id")
    .limit(1);

  if (error) {
    // 23505 = outra resposta simultânea já inseriu a mesma mensagem.
    if (error.code === "23505") {
      const raced = await findMessageByProviderId(item.waha_message_id);
      return raced?.conversation_id === conversationId ? raced.id : null;
    }
    console.error(
      "[recordCampaignReply] falha ao inserir mensagem do disparo (migration 126?):",
      error.message
    );
    return null;
  }
  return inserted?.[0]?.id ?? null;
}

async function findMessageByProviderId(
  providerId: string
): Promise<{ id: string; conversation_id: string } | null> {
  const { data, error } = await supabaseAdmin()
    .from("messages")
    .select("id, conversation_id")
    .eq("message_id", providerId)
    .limit(1);
  if (error) {
    console.error("[recordCampaignReply] falha ao buscar mensagem do disparo:", error.message);
    return null;
  }
  return data?.[0] ?? null;
}
