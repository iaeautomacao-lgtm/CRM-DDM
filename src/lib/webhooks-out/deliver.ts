import "server-only";
// PRD 15, 15.14 — entrega dos webhooks de saída (drena wacrm.webhook_deliveries).
//
// Por entrega: reserva (claim, lease 120 s) → assina (HMAC) → POST via safeFetch (SSRF-guard, sem redirect, resposta ≤ 64 KB, 10 s)
// → complete / fail. Falha repete com backoff exponencial (30 s · 2^n, teto 1 h, jitter) até 12 tentativas e vira `dead`
// (replay manual). Erro que repetir não resolve (host bloqueado pelo SSRF-guard, redirect, segredo ilegível) vira `dead` na hora.
// Garantia: pelo menos uma vez (o receptor deduplica pelo `id` do evento / X-CRM-Delivery); sem garantia de ordem entre eventos.
// Nunca registra URL, corpo ou segredo em log: só ids, evento, tentativa e HTTP.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { writeLog } from "@/lib/logger";
import { SsrfBlockedError, safeFetch } from "@/lib/security/ssrf-guard";
import { decrypt } from "@/lib/whatsapp/encryption";

import { signatureHeader } from "./signature";

export const DELIVERY_TIMEOUT_MS = 10_000;
export const DELIVERY_MAX_RESPONSE_BYTES = 64 * 1024;

export interface ClaimedDelivery {
  id: string;
  account_id: string;
  endpoint_id: string;
  event: string;
  payload: Record<string, unknown>;
  attempts: number;
  url: string;
  secret_enc: string;
}

export type Fetcher = typeof safeFetch;

export type DeliveryOutcome =
  | { kind: "delivered"; http: number }
  | { kind: "retry"; http: number | null; error: string }
  | { kind: "dead"; http: number | null; error: string };

/** Razões do SSRF-guard em que repetir não adianta (configuração do endpoint, não instabilidade). */
const FINAL_SSRF_REASONS = new Set(["invalid_url", "protocol", "credentials", "blocked_host", "blocked_ip", "too_many_redirects", "cross_origin_redirect"]);

/** Uma tentativa de entrega. Nunca lança. */
export async function attemptDelivery(row: ClaimedDelivery, fetcher: Fetcher = safeFetch, nowMs: number = Date.now()): Promise<DeliveryOutcome> {
  let secret: string;
  try {
    secret = decrypt(row.secret_enc);
  } catch {
    return { kind: "dead", http: null, error: "Segredo do endpoint ilegível (gere um novo segredo)" };
  }
  const body = JSON.stringify(row.payload);
  try {
    const res = await fetcher(
      row.url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          "user-agent": "CRM-DDM-Webhooks/1.0",
          "x-crm-event": row.event,
          "x-crm-delivery": row.id,
          "x-crm-attempt": String(row.attempts),
          "x-crm-signature": signatureHeader(secret, body, nowMs),
        },
        body,
      },
      { timeoutMs: DELIVERY_TIMEOUT_MS, maxBytes: DELIVERY_MAX_RESPONSE_BYTES, maxRedirects: 0, failOnCrossOriginRedirect: true },
    );
    if (res.status >= 200 && res.status < 300) return { kind: "delivered", http: res.status };
    return { kind: "retry", http: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      const reason = err.reason;
      return FINAL_SSRF_REASONS.has(reason)
        ? { kind: "dead", http: null, error: `Bloqueado pelo guard de rede (${reason})` }
        : { kind: "retry", http: null, error: `Falha de rede (${reason})` };
    }
    return { kind: "retry", http: null, error: `Falha de rede (${err instanceof Error ? err.name : "erro"})` };
  }
}

export interface DrainSummary {
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
}

/** Drena a fila dentro de um orçamento de tempo. Seguro com crons simultâneos (SKIP LOCKED + lease por dono). */
export async function drainWebhookDeliveries(
  db: Pick<SupabaseClient, "rpc">,
  options: { owner?: string; budgetMs?: number; batch?: number; concurrency?: number; fetcher?: Fetcher } = {},
): Promise<DrainSummary> {
  const owner = options.owner ?? randomUUID();
  const budgetMs = options.budgetMs ?? 50_000;
  const batch = Math.max(1, Math.min(options.batch ?? 20, 200));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 5, 20));
  const startedAt = Date.now();
  const summary: DrainSummary = { claimed: 0, delivered: 0, retried: 0, dead: 0 };

  while (Date.now() - startedAt < budgetMs) {
    const { data, error } = await db.rpc("claim_webhook_deliveries", { p_owner: owner, p_limit: batch });
    if (error) throw error;
    const rows = (data ?? []) as ClaimedDelivery[];
    if (rows.length === 0) break;
    summary.claimed += rows.length;

    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const row = rows[next++];
        const outcome = await attemptDelivery(row, options.fetcher);
        if (outcome.kind === "delivered") {
          await db.rpc("complete_webhook_delivery", { p_id: row.id, p_owner: owner, p_http: outcome.http });
          summary.delivered++;
          continue;
        }
        const { data: state } = await db.rpc("fail_webhook_delivery", {
          p_id: row.id,
          p_owner: owner,
          p_http: outcome.http,
          p_error: outcome.error,
          p_final: outcome.kind === "dead",
        });
        if (state === "dead") {
          summary.dead++;
          void writeLog({
            account_id: row.account_id,
            level: "warn",
            source: "api_v1",
            event: "webhook_delivery_dead",
            message: `Entrega de webhook esgotada (${row.event}) após ${row.attempts} tentativa(s)`,
            payload: { delivery_id: row.id, endpoint_id: row.endpoint_id, event: row.event, attempts: row.attempts, last_status: outcome.http },
          });
        } else {
          summary.retried++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
    if (rows.length < batch) break; // fila esvaziou
  }
  return summary;
}
