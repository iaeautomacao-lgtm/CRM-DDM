// Validação de mídia enviada pelo navegador ao Storage (chat-media, flow-media).
//
// O navegador NÃO sobe mais direto com a sessão: pede uma URL assinada ao servidor (POST /api/media/upload-url), que
// valida tipo e tamanho por tipo; depois de subir, o servidor revalida o OBJETO gravado (POST /api/media/confirm):
// tamanho e MIME gravados no Storage e os primeiros bytes (magic bytes). Objeto fora do permitido é apagado.
// Módulo puro (sem Supabase): vale no servidor e nos testes. O Content-Type que o navegador declara não é confiável.

import type { Permission } from "@/lib/auth/permissions";

export const MEDIA_BUCKETS = ["chat-media", "flow-media"] as const;
export type MediaBucket = (typeof MEDIA_BUCKETS)[number];

/** Quem pede o upload e para quê: define o bucket e a permissão exigida (o servidor revalida). */
export const MEDIA_PURPOSES = {
  inbox: { bucket: "chat-media", permission: "inbox.reply" },
  internal_chat: { bucket: "chat-media", permission: "account.view" },
  template: { bucket: "chat-media", permission: "templates.manage" },
  campaign: { bucket: "chat-media", permission: "campaigns.manage" },
  flow: { bucket: "flow-media", permission: "flows.edit" },
} as const satisfies Record<string, { bucket: MediaBucket; permission: Permission }>;

export type MediaPurpose = keyof typeof MEDIA_PURPOSES;

export function isMediaPurpose(value: unknown): value is MediaPurpose {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(MEDIA_PURPOSES, value);
}

export type MediaKind = "image" | "video" | "audio" | "document";

/** Tetos por tipo (mesmos de MEDIA_MAX_BYTES_BY_KIND: imagem 5 MB; o resto 16 MB, o limite do bucket). */
export const MEDIA_LIMIT_BYTES: Record<MediaKind, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 16 * 1024 * 1024,
};

/** Tipos aceitos = os `allowed_mime_types` dos buckets (migrations 016/023/111). */
export const ALLOWED_MEDIA_MIME: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/3gpp",
  "audio/ogg",
  "audio/mpeg",
  "audio/aac",
  "audio/mp4",
  "audio/amr",
  "audio/webm",
  "application/pdf",
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
]);

/** Normaliza o MIME declarado ("audio/ogg; codecs=opus" → "audio/ogg"). */
export function normalizeMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

export function isAllowedMime(mime: string): boolean {
  return ALLOWED_MEDIA_MIME.has(normalizeMime(mime));
}

export function mediaKindOf(mime: string): MediaKind {
  const m = normalizeMime(mime);
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  return "document";
}

export function maxBytesFor(mime: string): number {
  return MEDIA_LIMIT_BYTES[mediaKindOf(mime)];
}

export type UploadCheck = { ok: true; mime: string } | { ok: false; error: string };

/** Pedido de URL de upload: tipo permitido e tamanho dentro do teto do tipo. */
export function checkUploadRequest(input: { mime: unknown; size: unknown }): UploadCheck {
  const mime = typeof input.mime === "string" ? normalizeMime(input.mime) : "";
  if (!isAllowedMime(mime)) return { ok: false, error: "Tipo de arquivo não permitido." };
  const size = typeof input.size === "number" ? input.size : -1;
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: "Arquivo vazio ou tamanho inválido." };
  const max = maxBytesFor(mime);
  if (size > max) return { ok: false, error: `O arquivo passa do limite de ${Math.round(max / 1024 / 1024)} MB para este tipo.` };
  return { ok: true, mime };
}

// ── Magic bytes ─────────────────────────────────────────────────────────

const startsWith = (b: Uint8Array, sig: readonly number[], offset = 0): boolean => sig.every((v, i) => b[offset + i] === v);
const ascii = (b: Uint8Array, offset: number, len: number): string => String.fromCharCode(...b.slice(offset, offset + len));

export type Sniffed =
  | "png"
  | "jpeg"
  | "webp"
  | "pdf"
  | "mp4"
  | "3gp"
  | "ogg"
  | "mp3"
  | "aac"
  | "amr"
  | "ebml"
  | "ole"
  | "zip"
  | "text"
  | null;

/** Identifica o formato pelos primeiros bytes (≥ 32 bytes). null = não reconhecido. */
export function sniffFormat(bytes: Uint8Array): Sniffed {
  if (bytes.length < 4) return null;
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "webp";
  if (ascii(bytes, 0, 4) === "%PDF") return "pdf";
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === "ftyp") return ascii(bytes, 8, 3) === "3gp" ? "3gp" : "mp4";
  if (ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (ascii(bytes, 0, 5) === "#!AMR") return "amr";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "ebml";
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (ascii(bytes, 0, 2) === "PK" && (bytes[2] === 0x03 || bytes[2] === 0x05)) return "zip";
  if (ascii(bytes, 0, 3) === "ID3") return "mp3";
  // Quadro MPEG de áudio: 11 bits de sincronismo; camada 3 = mp3, camada 0 + ADTS (0xFFF1/0xFFF9) = aac.
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    const layer = (bytes[1] >> 1) & 0x03;
    return layer === 0 ? "aac" : "mp3";
  }
  if (looksLikeText(bytes)) return "text";
  return null;
}

/** Texto plano: sem byte nulo nem controles fora de \t \n \r e UTF-8 válido nos bytes lidos. */
function looksLikeText(bytes: Uint8Array): boolean {
  for (const v of bytes) {
    if (v === 0) return false;
    if (v < 0x20 && v !== 0x09 && v !== 0x0a && v !== 0x0d) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    // Corte no meio de um caractere multibyte (leitura parcial): tolera só se o erro está no fim.
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, Math.max(0, bytes.length - 3)));
      return true;
    } catch {
      return false;
    }
  }
}

const MAGIC_FOR_MIME: Record<string, readonly Sniffed[]> = {
  "image/png": ["png"],
  "image/jpeg": ["jpeg"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
  "video/mp4": ["mp4", "3gp"],
  "video/3gpp": ["3gp", "mp4"],
  "audio/mp4": ["mp4", "3gp"],
  "audio/aac": ["aac", "mp4"],
  "audio/ogg": ["ogg"],
  "audio/mpeg": ["mp3"],
  "audio/amr": ["amr"],
  "audio/webm": ["ebml"],
  "application/msword": ["ole"],
  "application/vnd.ms-excel": ["ole"],
  "application/vnd.ms-powerpoint": ["ole"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["zip"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["zip"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["zip"],
  "text/plain": ["text"],
};

/** O conteúdo (primeiros bytes) bate com o MIME gravado? */
export function magicMatchesMime(mime: string, bytes: Uint8Array): boolean {
  const expected = MAGIC_FOR_MIME[normalizeMime(mime)];
  if (!expected) return false;
  const found = sniffFormat(bytes);
  return found !== null && expected.includes(found);
}

export type ObjectCheck = { ok: true; mime: string; kind: MediaKind } | { ok: false; error: string };

/**
 * Revalida o objeto já gravado: MIME gravado permitido, tamanho dentro do teto do tipo e magic bytes coerentes.
 * `metadata` vem do Storage (`size`, `mimetype`); `head` são os primeiros bytes do arquivo.
 */
export function checkStoredObject(metadata: { size?: unknown; mimetype?: unknown }, head: Uint8Array): ObjectCheck {
  const mime = typeof metadata.mimetype === "string" ? normalizeMime(metadata.mimetype) : "";
  if (!isAllowedMime(mime)) return { ok: false, error: "Tipo de arquivo não permitido." };
  const size = typeof metadata.size === "number" ? metadata.size : -1;
  if (size <= 0) return { ok: false, error: "Arquivo vazio." };
  if (size > maxBytesFor(mime)) return { ok: false, error: "O arquivo passa do limite do tipo." };
  if (!magicMatchesMime(mime, head)) return { ok: false, error: "O conteúdo do arquivo não confere com o tipo informado." };
  return { ok: true, mime, kind: mediaKindOf(mime) };
}

/** O caminho pertence à pasta da conta e não tem segmentos perigosos. */
export function isAccountMediaPath(path: string, accountId: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > 300) return false;
  if (!path.startsWith(`account-${accountId}/`)) return false;
  const rest = path.slice(`account-${accountId}/`.length);
  if (!rest || rest.includes("..") || rest.includes("\\") || rest.startsWith("/")) return false;
  return !rest.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
}
