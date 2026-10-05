import { supabaseAdmin } from "@/lib/flows/admin-client";
import { decrypt } from "@/lib/whatsapp/encryption";
import { resolveProviderMedia } from "@/lib/storage/provider-media";
import type { WebchatInteractivePayload } from "@/lib/webchat/send";
import { sendSocial, socialWindow, type SocialChannelType } from "./graph";

// Envio no Instagram/Messenger a partir de uma conversa do CRM. Usado pelo
// motor de fluxos, pela IA e pelo inbox — mesmo papel que meta-send.ts e
// waha-send.ts têm para o WhatsApp.

export interface ChannelRow {
  id: string;
  account_id: string;
  type: SocialChannelType | "sms";
  name: string;
  external_id: string;
  access_token: string;
  team_id: string | null;
  flow_id: string | null;
  client_id: string | null;
  habilitado: boolean;
  status: string;
}

/** Linha do canal com o token já decifrado (nunca devolver isso ao navegador). */
export async function loadChannel(channelId: string): Promise<ChannelRow | null> {
  const { data } = await supabaseAdmin().from("channels").select("*").eq("id", channelId).limit(1);
  const row = data?.[0] as ChannelRow | undefined;
  if (!row) return null;
  return { ...row, access_token: decrypt(row.access_token) };
}

export class SocialWindowClosedError extends Error {
  constructor(readonly window: "human_agent" | "closed") {
    super(
      window === "human_agent"
        ? "Mais de 24h desde a última mensagem do cliente: só um atendente pode responder (até 7 dias)."
        : "Mais de 7 dias desde a última mensagem do cliente: o canal não permite enviar.",
    );
    this.name = "SocialWindowClosedError";
  }
}

export interface SocialOutgoingMessage {
  conversationId: string;
  senderType: "bot" | "agent";
  /** Atendente humano (habilita a tag HUMAN_AGENT entre 24h e 7 dias). */
  senderId?: string;
  contentType: "text" | "image" | "video" | "audio" | "document" | "interactive";
  text?: string | null;
  /** Referência estável do chat-media ou URL pública. */
  mediaUrl?: string | null;
  /** Botões/lista do fluxo viram respostas rápidas (quick replies). */
  interactive?: WebchatInteractivePayload;
}

export async function sendSocialMessage(
  msg: SocialOutgoingMessage,
): Promise<{ whatsapp_message_id: string; id: string }> {
  const db = supabaseAdmin();
  const { data: convRows } = await db
    .from("conversations")
    .select("id, account_id, contact_id, channel_id, channel_type, last_customer_message_at")
    .eq("id", msg.conversationId)
    .limit(1);
  const conv = convRows?.[0];
  if (!conv?.channel_id) throw new Error("conversa sem canal social");
  const channel = await loadChannel(conv.channel_id);
  if (!channel || channel.account_id !== conv.account_id || channel.type === "sms") {
    throw new Error("canal social indisponível");
  }

  const { data: identities } = await db
    .from("contact_identities")
    .select("external_id")
    .eq("contact_id", conv.contact_id)
    .eq("channel_id", channel.id)
    .limit(1);
  const recipientId = identities?.[0]?.external_id;
  if (!recipientId) throw new Error("contato sem identidade neste canal");

  const window = socialWindow(conv.last_customer_message_at);
  const isHuman = msg.senderType === "agent" && !!msg.senderId;
  if (window === "closed" || (window === "human_agent" && !isHuman)) {
    throw new SocialWindowClosedError(window === "closed" ? "closed" : "human_agent");
  }
  const base = {
    type: channel.type,
    accountExternalId: channel.external_id,
    accessToken: channel.access_token,
    recipientId,
    humanAgentTag: window === "human_agent",
  } as const;

  let messageId = "";
  if (msg.mediaUrl && msg.contentType !== "text" && msg.contentType !== "interactive") {
    // A Meta baixa a mídia pela URL: URL assinada curta do bucket privado.
    const url = await resolveProviderMedia(msg.mediaUrl, conv.account_id);
    const mediaType = msg.contentType === "document" ? "file" : msg.contentType;
    ({ messageId } = await sendSocial({ ...base, message: { kind: "attachment", mediaType, url } }));
    if (msg.text?.trim()) {
      await sendSocial({ ...base, message: { kind: "text", text: msg.text } });
    }
  } else {
    const options =
      msg.interactive?.type === "buttons"
        ? msg.interactive.options
        : msg.interactive?.type === "list"
          ? msg.interactive.sections.flatMap((s) => s.options)
          : [];
    ({ messageId } = await sendSocial({
      ...base,
      message: {
        kind: "text",
        text: msg.text ?? "",
        quickReplies: options.map((o) => ({ title: o.title, payload: o.id })),
      },
    }));
  }

  const now = new Date().toISOString();
  const { data: inserted, error } = await db
    .from("messages")
    .insert({
      conversation_id: msg.conversationId,
      sender_type: msg.senderType,
      sender_id: msg.senderId ?? null,
      content_type: msg.contentType,
      content_text: msg.text ?? null,
      media_url: msg.mediaUrl ?? null,
      interactive_payload: msg.interactive ?? null,
      message_id: messageId,
      status: "sent",
      created_at: now,
    })
    .select("id")
    .limit(1);
  if (error) {
    // Já saiu na Meta: não falhar o envio (evita reenvio pelo atendente).
    console.error("[social] enviado, mas falhou ao gravar:", error.message);
  }
  await db
    .from("conversations")
    .update({
      last_message_text: msg.text?.trim() || `[${msg.contentType}]`,
      last_message_at: now,
      updated_at: now,
    })
    .eq("id", msg.conversationId);

  return { whatsapp_message_id: messageId, id: inserted?.[0]?.id ?? "" };
}
