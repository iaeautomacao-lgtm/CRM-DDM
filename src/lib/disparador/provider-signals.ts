import { MetaApiError, MetaUncertainResponseError } from "@/lib/whatsapp/meta-api";
import { metaCodesWhere } from "./meta-error-catalog";

// Sinais do provedor que pedem para o número desacelerar (backoff
// adaptativo do cron). Só observação: nada aqui muda o destino do item —
// erro/retry/reconciliação continuam decididos em processQueue.ts.

export type BackoffReason = "rate_limit" | "server_error" | "timeout" | "network";

// Códigos Meta de limite de taxa:
// 4 (limite da aplicação), 80007 (limite da WABA), 130429 (throughput do
// número), 131048 (limite por spam), 131056 (limite por par
// remetente/destinatário).
// Derivado do catálogo único (meta-error-catalog.ts): flag `freio`.
export const META_RATE_LIMIT_CODES = metaCodesWhere((e) => e.freio === true);

export interface ProviderErrorClass {
  reason: BackoffReason | null;
  /** Chave curta para a telemetria (ex.: "meta:131056", "waha:503", "timeout"). */
  code: string;
}

export function classifyProviderError(err: unknown): ProviderErrorClass {
  if (err instanceof MetaApiError) {
    const code = err.metaCode !== null ? `meta:${err.metaCode}` : `meta:http_${err.httpStatus}`;
    if (err.httpStatus === 429 || (err.metaCode !== null && META_RATE_LIMIT_CODES.has(err.metaCode)))
      return { reason: "rate_limit", code };
    if (err.httpStatus >= 500) return { reason: "server_error", code };
    return { reason: null, code };
  }
  // 2xx sem messages[0].id (F13): resultado incerto, sem freio no número.
  if (err instanceof MetaUncertainResponseError) return { reason: null, code: "meta:uncertain_body" };
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|aborted/i.test(message))
    return { reason: "timeout", code: "timeout" };
  const http =
    message.match(/^WAHA \w+ failed \((\d{3})\)/) ?? message.match(/^Failed to start WaCalls call: (\d{3})/);
  if (http) {
    const status = Number(http[1]);
    const code = `waha:${status}`;
    if (status === 429) return { reason: "rate_limit", code };
    if (status >= 500) return { reason: "server_error", code };
    return { reason: null, code };
  }
  if (name === "TypeError" && /fetch failed|network|ECONN|ENOTFOUND|socket/i.test(message))
    return { reason: "network", code: "network" };
  return { reason: null, code: "other" };
}
