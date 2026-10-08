// Corpo de webhook com teto e assinatura verificada ANTES do parse (PRD 14, 14.10 — SW-5).
//
// Webhooks são públicos: quem os chama pode mandar centenas de MB (o processo é único e guarda o corpo na memória) ou lixo que
// só custa CPU no JSON.parse. Por isso, nas três rotas (WhatsApp/Meta, social/Meta e WAHA):
//   1. o corpo é lido com TETO (readCappedBody): recusa pelo Content-Length declarado E interrompe a leitura do stream assim que
//      passar do teto (um chunked sem Content-Length não escapa);
//   2. a autenticação (HMAC/segredo) acontece sobre o BRUTO, antes do JSON.parse, sempre que o segredo não depende do conteúdo.

/** Teto de corpo dos POSTs de webhook (statuses/mensagens são pequenos; 1 MB é folgado). */
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;

export type CappedBody = { ok: true; text: string } | { ok: false; status: 413 };

/**
 * Lê o corpo como texto UTF-8 com teto de `maxBytes`. 413 se o Content-Length declarado ou o total lido passar do teto
 * (a leitura é cancelada ao estourar). Corpo ausente = texto vazio.
 */
export async function readCappedBody(request: Request, maxBytes: number = MAX_WEBHOOK_BODY_BYTES): Promise<CappedBody> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, status: 413 };

  const stream = request.body;
  if (!stream) return { ok: true, text: "" };

  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, status: 413 };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
  return { ok: true, text };
}

/** `sha256=<64 hex>` — a única forma que a Meta envia em X-Hub-Signature-256. Barra lixo ANTES do parse. */
export function isWellFormedHubSignature(signature: string | null | undefined): signature is string {
  return typeof signature === "string" && /^sha256=[0-9a-f]{64}$/i.test(signature);
}
