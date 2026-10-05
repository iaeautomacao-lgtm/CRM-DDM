// Cliente HTTP das APIs da Meta para Instagram (Instagram API com
// Instagram Login, host graph.instagram.com) e Messenger (Graph API da
// Página, host graph.facebook.com). Endpoints conferidos na documentação
// oficial (out/2026):
//   Instagram: POST https://graph.instagram.com/v25.0/<IG_ID>/messages
//              Authorization: Bearer <token do usuário do Instagram>
//   Messenger: POST https://graph.facebook.com/v25.0/<PAGE_ID>/messages
//              ?access_token=<token da Página>
// Ambos: { recipient: { id }, message: { text | attachment | quick_replies } }
// e resposta { recipient_id, message_id }.

export type SocialChannelType = "instagram" | "messenger";

export const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? "v25.0";
const GRAPH_TIMEOUT_MS = 30_000;

/** Limites da Meta para respostas rápidas (quick_replies). */
export const QUICK_REPLY_LIMITS = { max: 13, titleMax: 20 } as const;

export class GraphApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

function graphHost(type: SocialChannelType): string {
  return type === "instagram" ? "https://graph.instagram.com" : "https://graph.facebook.com";
}

/** Fetch com timeout e erro tipado (mensagem e código vindos da Meta). */
export async function graphFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) });
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number };
  } & T;
  if (!res.ok || body.error) {
    throw new GraphApiError(
      body.error?.message ?? `Meta API error ${res.status}`,
      res.status,
      body.error?.code ?? null,
    );
  }
  return body as T;
}

export interface SocialOutgoing {
  type: SocialChannelType;
  /** IG user id (Instagram) ou Page id (Messenger). */
  accountExternalId: string;
  accessToken: string;
  /** IGSID / PSID do cliente. */
  recipientId: string;
  /**
   * Fora da janela de 24h a mensagem só sai com a tag HUMAN_AGENT (até 7
   * dias depois da última mensagem do cliente).
   */
  humanAgentTag?: boolean;
  message:
    | { kind: "text"; text: string; quickReplies?: Array<{ title: string; payload: string }> }
    | { kind: "attachment"; mediaType: "image" | "video" | "audio" | "file"; url: string };
}

/** Corpo do Send API (mesmo formato nos dois canais). Puro, testável. */
export function buildSendBody(out: SocialOutgoing): Record<string, unknown> {
  const message =
    out.message.kind === "text"
      ? {
          text: out.message.text,
          ...(out.message.quickReplies?.length
            ? {
                quick_replies: out.message.quickReplies
                  .slice(0, QUICK_REPLY_LIMITS.max)
                  .map((q) => ({
                    content_type: "text",
                    title: q.title.slice(0, QUICK_REPLY_LIMITS.titleMax),
                    payload: q.payload,
                  })),
              }
            : {}),
        }
      : { attachment: { type: out.message.mediaType, payload: { url: out.message.url } } };
  return {
    recipient: { id: out.recipientId },
    ...(out.humanAgentTag
      ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" }
      : { messaging_type: "RESPONSE" }),
    message,
  };
}

export async function sendSocial(out: SocialOutgoing): Promise<{ messageId: string }> {
  const base = `${graphHost(out.type)}/${GRAPH_VERSION}/${out.accountExternalId}/messages`;
  const isInstagram = out.type === "instagram";
  const res = await graphFetch<{ message_id: string }>(
    isInstagram ? base : `${base}?access_token=${encodeURIComponent(out.accessToken)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(isInstagram ? { Authorization: `Bearer ${out.accessToken}` } : {}),
      },
      body: JSON.stringify(buildSendBody(out)),
    },
  );
  return { messageId: res.message_id };
}

/** Nome e foto do cliente para criar o contato (best-effort). */
export async function fetchSocialProfile(
  type: SocialChannelType,
  userId: string,
  accessToken: string,
): Promise<{ name: string | null; username: string | null; avatarUrl: string | null }> {
  try {
    if (type === "instagram") {
      const p = await graphFetch<{ name?: string; username?: string; profile_pic?: string }>(
        `https://graph.instagram.com/${GRAPH_VERSION}/${userId}?fields=name,username,profile_pic`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      return { name: p.name ?? null, username: p.username ?? null, avatarUrl: p.profile_pic ?? null };
    }
    const p = await graphFetch<{ first_name?: string; last_name?: string; profile_pic?: string }>(
      `https://graph.facebook.com/${GRAPH_VERSION}/${userId}?fields=first_name,last_name,profile_pic&access_token=${encodeURIComponent(accessToken)}`,
    );
    const name = [p.first_name, p.last_name].filter(Boolean).join(" ") || null;
    return { name, username: null, avatarUrl: p.profile_pic ?? null };
  } catch {
    return { name: null, username: null, avatarUrl: null };
  }
}

/**
 * Regra de janela dos dois canais: até 24h da última mensagem do cliente
 * responde normal; de 24h a 7 dias só com HUMAN_AGENT (e só atendente
 * humano pode usar); depois disso não dá para enviar.
 */
export function socialWindow(
  lastCustomerMessageAt: string | null,
  now = Date.now(),
): "open" | "human_agent" | "closed" {
  if (!lastCustomerMessageAt) return "closed";
  const hours = (now - Date.parse(lastCustomerMessageAt)) / 3_600_000;
  if (hours < 24) return "open";
  if (hours < 24 * 7) return "human_agent";
  return "closed";
}
