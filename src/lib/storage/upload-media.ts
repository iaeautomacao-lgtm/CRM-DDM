import { apiFetch } from "@/lib/api-fetch";
import { createClient } from "@/lib/supabase/client";
import { checkUploadRequest, type MediaPurpose } from "./media-validation";

/**
 * Shared media-upload helper for Supabase Storage buckets that use the
 * account-scoped path convention introduced in migration 020
 * (`flow-media`) and reused by migration 023 (`chat-media`):
 *
 *   <bucket>/account-<account_id>/<timestamp>-<basename>.<ext>
 *
 * The first path segment (`account-<uuid>`) is what the bucket's RLS
 * write policies match on, so every caller MUST go through here rather
 * than hand-rolling a path — a mismatched segment is silently rejected
 * by RLS. Both the Flows builder (`node-config-form`) and the inbox
 * composer call this so the logic lives in exactly one place.
 */

/** 16 MB — matches the `file_size_limit` on both buckets (migrations 016/020/023). */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Per-kind upload ceilings that mirror Meta's WhatsApp Cloud API caps so
 * a file that the bucket would accept (≤16 MB) but Meta would reject is
 * caught client-side BEFORE upload — otherwise it lands in storage as an
 * orphan and the send fails with a confusing 400. Images are Meta's
 * tightest cap at 5 MB; documents are held at the 16 MB bucket limit
 * (Meta allows 100 MB, but the bucket — and shared-hosting upload UX —
 * caps lower).
 */
export const MEDIA_MAX_BYTES_BY_KIND = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 16 * 1024 * 1024,
} as const;

/**
 * Build the account-scoped object path for an upload. Pure + exported so
 * it can be unit-tested without a Supabase client.
 *
 * - `basename` is stripped of its extension, lower-cased non-safe chars
 *   are collapsed to `_`, and it's capped at 40 chars (falls back to
 *   "file" when empty).
 * - The timestamp + the original name keep collisions between two
 *   concurrent uploads astronomically unlikely.
 */
export function buildMediaPath(
  accountId: string,
  fileName: string,
  now: number = Date.now(),
): string {
  // Only treat the trailing segment as an extension when there's a real
  // one — a bare name like "README" has no extension and falls back to
  // "bin" rather than becoming "readme".
  const hasExt = /\.[^.]+$/.test(fileName);
  const ext = hasExt ? fileName.split(".").pop()!.toLowerCase() : "bin";
  const safeBase =
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 40) || "file";
  return `account-${accountId}/${now}-${safeBase}.${ext}`;
}

export interface UploadAccountMediaResult {
  /** Referência a gravar/usar: `/api/chat-media/...` (chat-media) ou URL pública (flow-media). */
  publicUrl: string;
  /** Caminho do objeto no bucket (dentro da pasta da conta). */
  path: string;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const payload = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof payload.error === "string" && payload.error ? payload.error : fallback;
}

/**
 * Envia um arquivo ao Storage por URL assinada emitida pelo SERVIDOR e devolve a referência a usar. Fluxo:
 *   1. POST /api/media/upload-url — o servidor confere permissão da origem, tipo e tamanho por tipo e devolve um caminho
 *      dentro da pasta da conta + token de upload;
 *   2. o navegador sobe o arquivo com o token (a sessão do usuário não escreve mais no bucket);
 *   3. POST /api/media/confirm — o servidor revalida o objeto gravado (MIME, tamanho e magic bytes); fora do permitido,
 *      apaga e recusa.
 * Lança com mensagem pronta para o usuário (os chamadores mostram em toast). `purpose` define bucket e permissão.
 */
export async function uploadAccountMedia(purpose: MediaPurpose, file: File): Promise<UploadAccountMediaResult> {
  // Mesma checagem do servidor, antes de gastar uma ida e volta.
  const pre = checkUploadRequest({ mime: file.type, size: file.size });
  if (!pre.ok) throw new Error(pre.error);

  const headers = { "Content-Type": "application/json" };
  const urlRes = await apiFetch("/api/media/upload-url", {
    method: "POST",
    headers,
    body: JSON.stringify({ purpose, name: file.name, mime_type: pre.mime, size: file.size }),
  });
  if (!urlRes.ok) throw new Error(await readError(urlRes, "Não foi possível enviar o anexo."));
  const target = (await urlRes.json()) as { bucket: string; path: string; upload_token: string };

  const supabase = createClient();
  const { error: upErr } = await supabase.storage
    .from(target.bucket)
    .uploadToSignedUrl(target.path, target.upload_token, file, { contentType: pre.mime });
  if (upErr) throw new Error("Não foi possível enviar o anexo.");

  const confirmRes = await apiFetch("/api/media/confirm", {
    method: "POST",
    headers,
    body: JSON.stringify({ purpose, path: target.path }),
  });
  if (!confirmRes.ok) throw new Error(await readError(confirmRes, "Não foi possível verificar o anexo."));
  const confirmed = (await confirmRes.json()) as { path: string; url: string };
  return { publicUrl: confirmed.url, path: confirmed.path };
}

/**
 * Descarta um anexo em rascunho (enviado e não usado): rascunho cancelado, envio que falhou. O navegador não apaga mais direto no
 * Storage (migration 351 removeu as policies de escrita): passa por POST /api/media/delete, que só apaga objeto da própria conta
 * criado há pouco. Best-effort: os chamadores disparam sem esperar e ignoram o erro (anexo esquecido é sujeira, não falha).
 */
export async function deleteAccountMedia(purpose: MediaPurpose, path: string): Promise<void> {
  const res = await apiFetch("/api/media/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purpose, path }),
  });
  if (!res.ok) throw new Error(await readError(res, "Não foi possível descartar o anexo."));
}
