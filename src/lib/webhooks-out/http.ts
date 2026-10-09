// PRD 15, 15.14 — utilitários das rotas /api/v1/webhooks.
import { badRequest, payloadTooLarge } from "@/lib/api/v1/respond";

const MAX_BODY_BYTES = 16 * 1024;

/** Corpo JSON (objeto) com teto de 16 KB; vazio vira {}. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw payloadTooLarge("Corpo grande demais (máx. 16 KB)");
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw badRequest("Corpo deve ser JSON válido");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw badRequest("Corpo deve ser um objeto JSON");
  return parsed as Record<string, unknown>;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
