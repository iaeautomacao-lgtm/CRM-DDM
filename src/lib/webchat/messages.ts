import { chatMediaPath } from "@/lib/storage/chat-media";
import type { WebchatInteractivePayload } from "./send";

// Funções puras da troca de mensagens com a página do cliente.

/** Tipos de arquivo que o cliente pode enviar pelo Webchat. */
export const WEBCHAT_ALLOWED_MIME = /^(image\/(jpeg|png|webp|gif)|video\/(mp4|quicktime|webm)|audio\/(mpeg|mp4|ogg|webm|wav|aac|x-m4a)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet)|application\/vnd\.ms-excel|text\/plain)$/;

export type WebchatMediaKind = "image" | "video" | "audio" | "document";

export function mediaKindFromMime(mime: string): WebchatMediaKind {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "document";
}

/** Nome de arquivo seguro para o caminho no Storage. */
export function safeUploadName(name: string): string {
  const cleaned = name.normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  return (cleaned || "arquivo").slice(-80);
}

/**
 * URL que a página do cliente usa para abrir uma mídia. Anexos do bucket
 * privado chat-media passam pela rota do Webchat (autorizada pelo token);
 * URLs externas (ex.: mídia pública de um nó de fluxo) vão como estão.
 */
export function webchatMediaHref(token: string, mediaUrl: string | null): string | null {
  if (!mediaUrl) return null;
  if (!chatMediaPath(mediaUrl)) return mediaUrl;
  return `/api/webchat/${token}/media?ref=${encodeURIComponent(mediaUrl)}`;
}

export interface WebchatClientMessage {
  id: string;
  from: "customer" | "business";
  content_type: string;
  text: string | null;
  media_url: string | null;
  interactive: WebchatInteractivePayload | null;
  created_at: string;
}

interface MessageRow {
  id: string;
  sender_type: string;
  content_type: string;
  content_text: string | null;
  media_url: string | null;
  interactive_payload: WebchatInteractivePayload | null;
  created_at: string;
}

/**
 * Formato enviado ao navegador do cliente: sem ids de atendente, status
 * interno ou ids de provedor — só o que a página desenha.
 */
export function toClientMessage(token: string, row: MessageRow): WebchatClientMessage {
  return {
    id: row.id,
    from: row.sender_type === "customer" ? "customer" : "business",
    content_type: row.content_type,
    text: row.content_text,
    media_url: webchatMediaHref(token, row.media_url),
    interactive: row.interactive_payload ?? null,
    created_at: row.created_at,
  };
}
