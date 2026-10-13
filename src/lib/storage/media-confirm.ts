// Servidor: URL assinada de upload e revalidação do objeto gravado (usado por /api/media/upload-url e /api/media/confirm).
// Importa o cliente admin (server-only), então um componente de cliente nunca alcança este módulo.
import { randomUUID } from "node:crypto";

import { supabaseAdmin } from "@/lib/flows/admin-client";
import { chatMediaReference } from "@/lib/storage/chat-media";
import { checkStoredObject, type MediaBucket, type MediaKind } from "@/lib/storage/media-validation";
import { safeUploadName } from "@/lib/webchat/messages";

/** Quantos bytes lidos do início do arquivo para conferir o formato. */
const HEAD_BYTES = 64;

/** Caminho do objeto: sempre dentro da pasta da conta, com nome aleatório (nunca sobrescreve nem adivinha). */
export function buildServerMediaPath(accountId: string, fileName: string): string {
  return `account-${accountId}/${randomUUID()}-${safeUploadName(fileName)}`;
}

export async function createUploadTarget(bucket: MediaBucket, path: string): Promise<{ path: string; token: string } | null> {
  const { data, error } = await supabaseAdmin().storage.from(bucket).createSignedUploadUrl(path);
  if (error || !data) {
    console.error("[media/upload-url] falha ao gerar a URL de upload:", error?.message);
    return null;
  }
  return { path: data.path, token: data.token };
}

/** Lê só o começo do objeto (Range) por uma URL assinada curta. null = não foi possível ler. */
async function readHead(bucket: MediaBucket, path: string): Promise<Uint8Array | null> {
  const { data, error } = await supabaseAdmin().storage.from(bucket).createSignedUrl(path, 30);
  if (error || !data?.signedUrl) return null;
  try {
    const res = await fetch(data.signedUrl, { headers: { Range: `bytes=0-${HEAD_BYTES - 1}` }, cache: "no-store" });
    if (!res.ok && res.status !== 206) return null;
    return new Uint8Array(await res.arrayBuffer()).slice(0, HEAD_BYTES);
  } catch {
    return null;
  }
}

export type ConfirmResult =
  | { ok: true; mime: string; kind: MediaKind; url: string }
  | { ok: false; status: 404 | 422 | 503; code: "not_found" | "media_rejected" | "unavailable"; error: string };

/**
 * Revalida o objeto que o navegador subiu pela URL assinada (ela não impõe tipo nem tamanho): confere o MIME e o tamanho
 * GRAVADOS no Storage e os magic bytes. Se não passar, APAGA o objeto. Se passar, devolve a referência que vai no banco.
 */
export async function confirmUploadedMedia(bucket: MediaBucket, path: string): Promise<ConfirmResult> {
  const db = supabaseAdmin();
  const slash = path.lastIndexOf("/");
  const folder = path.slice(0, slash);
  const fileName = path.slice(slash + 1);

  const { data: objects, error: listError } = await db.storage.from(bucket).list(folder, { search: fileName, limit: 5 });
  if (listError) return { ok: false, status: 503, code: "unavailable", error: "Não foi possível verificar o arquivo." };
  const object = objects?.find((o) => o.name === fileName);
  if (!object) return { ok: false, status: 404, code: "not_found", error: "Arquivo não encontrado." };

  const head = await readHead(bucket, path);
  if (!head) return { ok: false, status: 503, code: "unavailable", error: "Não foi possível verificar o arquivo." };

  const metadata = (object.metadata ?? {}) as { size?: unknown; mimetype?: unknown };
  const checked = checkStoredObject(metadata, head);
  if (!checked.ok) {
    await db.storage.from(bucket).remove([path]);
    return { ok: false, status: 422, code: "media_rejected", error: checked.error };
  }

  const url = bucket === "chat-media" ? chatMediaReference(path) : db.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  return { ok: true, mime: checked.mime, kind: checked.kind, url };
}
