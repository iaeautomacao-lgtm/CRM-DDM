import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/flows/admin-client";

// Envio no canal Webchat = gravar a mensagem em `messages`. Não há
// provedor: a página do cliente (/w/<token>) busca as mensagens novas da
// conversa. Usado pelo motor de fluxos (sends do bot) e pelo inbox
// (resposta do atendente).

/** Botões ou lista que o fluxo mandou; a página desenha as opções. */
export type WebchatInteractivePayload =
  | { type: "buttons"; options: Array<{ id: string; title: string }> }
  | {
      type: "list";
      button_label?: string;
      sections: Array<{
        title?: string;
        options: Array<{ id: string; title: string; description?: string }>;
      }>;
    };

export interface WebchatOutgoingMessage {
  conversationId: string;
  senderType: "bot" | "agent";
  /** Atendente que respondeu pelo inbox (messages.sender_id). */
  senderId?: string;
  contentType: "text" | "image" | "video" | "audio" | "document" | "interactive";
  text?: string | null;
  /** Referência estável do chat-media (/api/chat-media/...) ou URL externa. */
  mediaUrl?: string | null;
  interactive?: WebchatInteractivePayload;
  replyToMessageId?: string | null;
}

/**
 * Grava uma mensagem de saída na conversa de Webchat e atualiza a prévia
 * da conversa. O `message_id` sintético (`webchat-<uuid>`) mantém a mesma
 * forma dos ids de provedor, então o motor de fluxos (last_prompt_message_id,
 * logs) funciona sem caso especial.
 */
export async function sendWebchatMessage(
  msg: WebchatOutgoingMessage
): Promise<{ whatsapp_message_id: string; id: string }> {
  const db = supabaseAdmin();
  const messageId = `webchat-${randomUUID()}`;
  const now = new Date().toISOString();

  const { data, error } = await db
    .from("messages")
    .insert({
      conversation_id: msg.conversationId,
      sender_type: msg.senderType,
      sender_id: msg.senderId ?? null,
      content_type: msg.contentType,
      content_text: msg.text ?? null,
      media_url: msg.mediaUrl ?? null,
      interactive_payload: msg.interactive ?? null,
      reply_to_message_id: msg.replyToMessageId ?? null,
      message_id: messageId,
      // Gravado = entregue na conversa; "lido" quando a página do cliente
      // buscar a mensagem (api/webchat/[token]/messages).
      status: "delivered",
      created_at: now,
    })
    .select("id")
    .limit(1);
  if (error) throw new Error(`webchat send failed: ${error.message}`);

  const preview = msg.text?.trim() || (msg.contentType === "text" ? "" : `[${msg.contentType}]`);
  const { error: convError } = await db
    .from("conversations")
    .update({ last_message_text: preview, last_message_at: now, updated_at: now })
    .eq("id", msg.conversationId);
  if (convError) console.error("[webchat] falha ao atualizar prévia da conversa:", convError.message);

  return { whatsapp_message_id: messageId, id: data?.[0]?.id ?? "" };
}

export type ConversationChannel = "whatsapp" | "webchat" | "instagram" | "messenger" | "sms";

const KNOWN_CHANNELS: readonly ConversationChannel[] = [
  "whatsapp",
  "webchat",
  "instagram",
  "messenger",
  "sms",
];

/** Canal da conversa (migrations 127/128). Conversas antigas são WhatsApp. */
export async function getConversationChannel(
  conversationId: string | null | undefined
): Promise<ConversationChannel> {
  if (!conversationId) return "whatsapp";
  const { data } = await supabaseAdmin()
    .from("conversations")
    .select("channel_type")
    .eq("id", conversationId)
    .limit(1);
  const value = data?.[0]?.channel_type as ConversationChannel | undefined;
  return value && KNOWN_CHANNELS.includes(value) ? value : "whatsapp";
}

/** Instagram/Messenger: envio pela Graph API (src/lib/channels/social.ts). */
export function isSocialChannel(channel: ConversationChannel): channel is "instagram" | "messenger" {
  return channel === "instagram" || channel === "messenger";
}
