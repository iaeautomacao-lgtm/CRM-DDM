import type { SocialChannelType } from "./graph";

// Parser puro do webhook da Meta para Instagram (object="instagram") e
// Messenger (object="page"). Formato conferido na documentação:
//   { object, entry: [{ id, time, messaging: [{ sender: { id },
//     recipient: { id }, timestamp, message: { mid, text, attachments,
//     quick_reply: { payload }, is_echo, reply_to: { mid } },
//     postback?: { mid, title, payload } }] }] }
// entry.id = conta profissional do Instagram / Página do Facebook.

export interface SocialInboundEvent {
  type: SocialChannelType;
  /** IG user id / Page id da nossa linha (resolve o canal). */
  accountExternalId: string;
  /** IGSID / PSID do cliente. */
  senderId: string;
  timestamp: number;
  mid: string;
  text: string | null;
  /** quick_reply.payload ou postback.payload = reply_id do botão do fluxo. */
  replyId: string | null;
  attachments: Array<{ type: string; url: string | null }>;
  replyToMid: string | null;
}

interface RawMessaging {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    quick_reply?: { payload?: string };
    reply_to?: { mid?: string };
    attachments?: Array<{ type?: string; payload?: { url?: string } }>;
  };
  postback?: { mid?: string; title?: string; payload?: string };
}

/**
 * Extrai as mensagens de clientes do corpo do webhook. Ignora ecos (nossas
 * próprias mensagens, que já gravamos no envio), leituras/entregas e
 * eventos sem id de mensagem.
 */
export function parseSocialWebhook(body: unknown): SocialInboundEvent[] {
  const root = body as { object?: string; entry?: Array<{ id?: string; messaging?: RawMessaging[] }> };
  const type: SocialChannelType | null =
    root?.object === "instagram" ? "instagram" : root?.object === "page" ? "messenger" : null;
  if (!type || !Array.isArray(root.entry)) return [];

  const events: SocialInboundEvent[] = [];
  for (const entry of root.entry) {
    for (const m of entry.messaging ?? []) {
      if (m.message?.is_echo) continue;
      const senderId = m.sender?.id;
      const accountExternalId = entry.id ?? m.recipient?.id;
      if (!senderId || !accountExternalId) continue;

      if (m.postback) {
        const mid = m.postback.mid;
        if (!mid) continue;
        events.push({
          type,
          accountExternalId,
          senderId,
          timestamp: m.timestamp ?? Date.now(),
          mid,
          text: m.postback.title ?? null,
          replyId: m.postback.payload ?? null,
          attachments: [],
          replyToMid: null,
        });
        continue;
      }
      const msg = m.message;
      if (!msg?.mid) continue;
      events.push({
        type,
        accountExternalId,
        senderId,
        timestamp: m.timestamp ?? Date.now(),
        mid: msg.mid,
        text: msg.text ?? null,
        replyId: msg.quick_reply?.payload ?? null,
        attachments: (msg.attachments ?? []).map((a) => ({
          type: a.type ?? "file",
          url: a.payload?.url ?? null,
        })),
        replyToMid: msg.reply_to?.mid ?? null,
      });
    }
  }
  return events;
}

/** content_type de `messages` para o tipo de anexo da Meta. */
export function socialAttachmentContentType(
  type: string,
): "image" | "video" | "audio" | "document" | "text" {
  switch (type) {
    case "image":
      return "image";
    case "video":
    case "ig_reel":
    case "reel":
      return "video";
    case "audio":
      return "audio";
    case "file":
      return "document";
    default:
      // share, story_mention, fallback: vira texto com o link.
      return "text";
  }
}
