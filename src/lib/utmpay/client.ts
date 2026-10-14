// CRM → UTMpay: geração de links rastreados em LOTE (contrato de 14/10).
//   POST {base_url}/api/gerar-links-lote   (X-API-Key)
//   { canal: 'whatsapp', campanha, url_destino (padrão do lote), alunos: [{ aluno_id: <cpf>, tid, url_destino? }] }
//   → { status, total, links: [{ tid, codigo, link_curto, ... }], erros: [{ index, aluno_id, mensagem }] }
// UM link por tid (tid = id do envio do CRM). O CPF só vai no corpo desta chamada servidor→servidor (HTTPS, com a chave); nunca em log.
import "server-only";
import { safeFetch } from "@/lib/security/ssrf-guard";
import type { UtmpayConfig } from "@/lib/utmpay/config";

export const UTMPAY_BATCH_MAX = 1000;
export const UTMPAY_TIMEOUT_MS = 10_000;

export interface UtmpayLinkRequest {
  /** id do envio do CRM (id do item da fila, ou um id avulso estável). */
  tid: string;
  /** Identificador do aluno no UTMpay (CPF só dígitos). */
  alunoId: string;
  /** Destino deste envio (o link que a operação informou); sem ele vale o padrão do lote. */
  destino?: string | null;
}

export interface UtmpayLink {
  tid: string;
  linkCurto: string;
  codigo: string | null;
}

export class UtmpayError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = true) {
    super(message);
    this.name = "UtmpayError";
    this.retryable = retryable;
  }
}

export type UtmpayFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;

const defaultFetch: UtmpayFetch = (url, init) => safeFetch(url, init, { timeoutMs: UTMPAY_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024, failOnCrossOriginRedirect: true });

/** Interpreta a resposta do lote (função pura). Itens sem link ficam de fora; quem chama trata o que faltou. */
export function parseBatchResponse(body: unknown): UtmpayLink[] {
  const links = (body as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) throw new UtmpayError("Resposta inesperada do UTMpay", false);
  const out: UtmpayLink[] = [];
  for (const item of links) {
    const l = item as { tid?: unknown; link_curto?: unknown; short_url?: unknown; codigo?: unknown } | null;
    const tid = typeof l?.tid === "string" ? l.tid : null;
    const link = typeof l?.link_curto === "string" ? l.link_curto : typeof l?.short_url === "string" ? l.short_url : null;
    if (!tid || !link || !/^https?:\/\//i.test(link)) continue;
    out.push({ tid, linkCurto: link, codigo: typeof l?.codigo === "string" ? l.codigo : null });
  }
  return out;
}

/** Gera os links de um lote (até 1000 por chamada; mais que isso é dividido). Falha de rede/HTTP ⇒ UtmpayError. */
export async function generateTrackedLinks(
  config: Pick<UtmpayConfig, "baseUrl" | "apiKey">,
  input: { campanha: string; canal?: string; destinoPadrao?: string | null; items: readonly UtmpayLinkRequest[] },
  fetcher: UtmpayFetch = defaultFetch,
): Promise<Map<string, UtmpayLink>> {
  const out = new Map<string, UtmpayLink>();
  if (!config.apiKey) throw new UtmpayError("Chave da API do UTMpay não configurada", false);
  for (let i = 0; i < input.items.length; i += UTMPAY_BATCH_MAX) {
    const chunk = input.items.slice(i, i + UTMPAY_BATCH_MAX);
    const payload = {
      canal: input.canal ?? "whatsapp",
      campanha: input.campanha,
      ...(input.destinoPadrao ? { url_destino: input.destinoPadrao } : {}),
      alunos: chunk.map((it) => ({ aluno_id: it.alunoId, tid: it.tid, ...(it.destino ? { url_destino: it.destino } : {}) })),
    };
    let res: Response;
    try {
      res = await fetcher(`${config.baseUrl}/api/gerar-links-lote`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": config.apiKey },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new UtmpayError("Falha de rede ao falar com o UTMpay");
    }
    // 207 = lote parcial (alguns itens com erro): aproveita os que vieram.
    if (!res.ok && res.status !== 207) {
      throw new UtmpayError(`UTMpay respondeu HTTP ${res.status}`, res.status >= 500 || res.status === 429 || res.status === 408);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new UtmpayError("Resposta do UTMpay não é JSON", false);
    }
    for (const link of parseBatchResponse(body)) out.set(link.tid, link);
  }
  return out;
}
