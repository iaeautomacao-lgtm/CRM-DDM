import "server-only";
import { NextResponse } from "next/server";
import { checkRateLimit, rateLimitResponse, type RateLimitOptions } from "@/lib/rate-limit";

// Guardas de custo para rotas (plano de segurança de 13/10, Âncora item 1): limite por usuário/conta e teto de corpo ANTES de ler o upload.

/** Aplica o limite e devolve a resposta 429 quando estourou; null = pode seguir. Mesmo contador compartilhado (migration 221) das demais rotas. */
export async function enforceRateLimit(key: string, options: RateLimitOptions): Promise<NextResponse | null> {
  const result = await checkRateLimit(key, options);
  return result.success ? null : rateLimitResponse(result);
}

/**
 * Recusa (413) quando o Content-Length declarado passa do teto, ANTES de `formData()`/`json()` carregar o corpo na memória.
 * Sem o cabeçalho (chunked) não dá para saber: segue, e o limite do arquivo/linhas da própria rota continua valendo.
 */
export function rejectOversizedBody(request: Request, maxBytes: number): NextResponse | null {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return NextResponse.json({ error: "Arquivo ou corpo grande demais.", code: "payload_too_large" }, { status: 413 });
  }
  return null;
}
