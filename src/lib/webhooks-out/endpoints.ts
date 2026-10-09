import "server-only";
// PRD 15, 15.14 — cadastro dos endpoints de webhook de saída por conta (usado pelas rotas /api/v1/webhooks).
// O segredo (`whsec_…`) é gerado aqui, devolvido UMA vez e guardado só cifrado (AES-256-GCM). Nunca volta em leitura.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { ApiError, badRequest, notFound } from "@/lib/api/v1/respond";
import { assertPublicUrl, SsrfBlockedError } from "@/lib/security/ssrf-guard";
import { encrypt } from "@/lib/whatsapp/encryption";

import { MAX_ENDPOINTS_PER_ACCOUNT, parseWebhookEvents, WEBHOOK_EVENTS, WEBHOOK_TEST_EVENT, type WebhookEvent } from "./catalog";
import { generateWebhookSecret } from "./signature";

type Db = Pick<SupabaseClient, "from" | "rpc">;

export interface EndpointView {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  status: "active" | "paused";
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  created_at: string;
}

const VIEW_COLUMNS = "id, url, description, events, status, consecutive_failures, last_success_at, last_failure_at, created_at";

/** 42P01/PGRST205 = a migration 204 ainda não foi aplicada: 503 em vez de 500. */
function unwrap<T>(result: { data: T | null; error: { code?: string; message?: string } | null }): T | null {
  if (result.error) {
    if (result.error.code === "42P01" || result.error.code === "PGRST205" || result.error.code === "42883" || result.error.code === "PGRST202") {
      throw new ApiError("unavailable", "Webhooks de saída indisponíveis: aplique a migration 204", 503);
    }
    throw result.error;
  }
  return result.data;
}

async function validateUrl(raw: unknown): Promise<string> {
  if (typeof raw !== "string" || !raw.trim()) throw badRequest("`url` é obrigatória");
  const value = raw.trim();
  if (value.length > 2000) throw badRequest("`url` longa demais (máx. 2000 caracteres)");
  if (!/^https:\/\//i.test(value)) throw badRequest("`url` deve usar https://");
  try {
    return (await assertPublicUrl(value)).toString();
  } catch (err) {
    if (err instanceof SsrfBlockedError) throw badRequest(`\`url\` não permitida (${err.reason}): use um endereço público`);
    throw badRequest("`url` inválida");
  }
}

function validateDescription(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || raw.length > 200) throw badRequest("`description` deve ser texto de até 200 caracteres");
  return raw;
}

function validateEvents(raw: unknown): WebhookEvent[] {
  const events = parseWebhookEvents(raw);
  if (!events) throw badRequest(`\`events\` deve listar ao menos um evento entre: ${WEBHOOK_EVENTS.join(", ")}`);
  return events;
}

export async function createEndpoint(
  db: Db,
  input: { accountId: string; keyId: string | null; url: unknown; events: unknown; description?: unknown },
): Promise<EndpointView & { secret: string }> {
  const url = await validateUrl(input.url);
  const events = validateEvents(input.events);
  const description = validateDescription(input.description);

  const count = await db.from("webhook_endpoints").select("id", { count: "exact", head: true }).eq("account_id", input.accountId);
  unwrap({ data: true, error: count.error });
  if ((count.count ?? 0) >= MAX_ENDPOINTS_PER_ACCOUNT) {
    throw new ApiError("conflict", `Limite de ${MAX_ENDPOINTS_PER_ACCOUNT} endpoints por conta atingido`, 409);
  }

  const secret = generateWebhookSecret();
  const row = unwrap(
    await db
      .from("webhook_endpoints")
      .insert({ account_id: input.accountId, url, events, description, secret_enc: encrypt(secret), created_by_key: input.keyId })
      .select(VIEW_COLUMNS)
      .limit(1),
  ) as EndpointView[] | null;
  if (!row?.[0]) throw new ApiError("internal", "Falha ao criar o endpoint", 500);
  return { ...row[0], secret };
}

export async function listEndpoints(db: Db, accountId: string): Promise<EndpointView[]> {
  const rows = unwrap(await db.from("webhook_endpoints").select(VIEW_COLUMNS).eq("account_id", accountId).order("created_at", { ascending: false }).limit(MAX_ENDPOINTS_PER_ACCOUNT));
  return (rows ?? []) as unknown as EndpointView[];
}

export async function getEndpoint(db: Db, accountId: string, id: string): Promise<EndpointView> {
  const rows = unwrap(await db.from("webhook_endpoints").select(VIEW_COLUMNS).eq("account_id", accountId).eq("id", id).limit(1)) as EndpointView[] | null;
  if (!rows?.[0]) throw notFound("Webhook não encontrado");
  return rows[0];
}

export async function updateEndpoint(db: Db, accountId: string, id: string, patch: Record<string, unknown>): Promise<EndpointView> {
  await getEndpoint(db, accountId, id);
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.url !== undefined) update.url = await validateUrl(patch.url);
  if (patch.events !== undefined) update.events = validateEvents(patch.events);
  if (patch.description !== undefined) update.description = validateDescription(patch.description);
  if (patch.status !== undefined) {
    if (patch.status !== "active" && patch.status !== "paused") throw badRequest("`status` deve ser 'active' ou 'paused'");
    update.status = patch.status;
  }
  if (Object.keys(update).length === 1) throw badRequest("Informe ao menos um campo: url, events, description ou status");
  const rows = unwrap(await db.from("webhook_endpoints").update(update).eq("account_id", accountId).eq("id", id).select(VIEW_COLUMNS).limit(1)) as EndpointView[] | null;
  if (!rows?.[0]) throw notFound("Webhook não encontrado");
  return rows[0];
}

export async function deleteEndpoint(db: Db, accountId: string, id: string): Promise<void> {
  await getEndpoint(db, accountId, id);
  unwrap(await db.from("webhook_endpoints").delete().eq("account_id", accountId).eq("id", id).select("id"));
}

/** Novo segredo (o anterior deixa de valer na hora; entregas pendentes já usam o novo). Devolvido UMA vez. */
export async function rotateSecret(db: Db, accountId: string, id: string): Promise<{ secret: string }> {
  await getEndpoint(db, accountId, id);
  const secret = generateWebhookSecret();
  unwrap(await db.from("webhook_endpoints").update({ secret_enc: encrypt(secret), updated_at: new Date().toISOString() }).eq("account_id", accountId).eq("id", id).select("id"));
  return { secret };
}

export interface DeliveryView {
  id: string;
  event: string;
  event_id: string;
  state: "pending" | "sending" | "delivered" | "dead";
  attempts: number;
  next_attempt_at: string;
  last_status: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

const STATES = ["pending", "sending", "delivered", "dead"] as const;

export function parseDeliveryCursor(raw: string | null): { created_at: string; id: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { c?: unknown; i?: unknown };
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string" || Number.isNaN(Date.parse(parsed.c)) || !/^[0-9a-f-]{36}$/i.test(parsed.i)) return null;
    return { created_at: parsed.c, id: parsed.i };
  } catch {
    return null;
  }
}

/** Entregas do endpoint, mais recentes primeiro (keyset por created_at+id). */
export async function listDeliveries(
  db: Db,
  accountId: string,
  endpointId: string,
  options: { state?: string | null; cursor?: string | null; limit?: number } = {},
): Promise<{ items: DeliveryView[]; next_cursor: string | null }> {
  await getEndpoint(db, accountId, endpointId);
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  if (options.state && !(STATES as readonly string[]).includes(options.state)) throw badRequest(`\`state\` deve ser um de: ${STATES.join(", ")}`);
  const cursor = parseDeliveryCursor(options.cursor ?? null);
  if (options.cursor && !cursor) throw badRequest("`cursor` inválido");

  let query = db
    .from("webhook_deliveries")
    .select("id, event, event_id, state, attempts, next_attempt_at, last_status, last_error, created_at, delivered_at")
    .eq("account_id", accountId)
    .eq("endpoint_id", endpointId);
  if (options.state) query = query.eq("state", options.state);
  if (cursor) query = query.or(`created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`);
  const rows = (unwrap(await query.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit + 1)) ?? []) as unknown as DeliveryView[];
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  const next_cursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ c: last.created_at, i: last.id })).toString("base64url") : null;
  return { items, next_cursor };
}

export async function replayDelivery(db: Db, accountId: string, endpointId: string, deliveryId: string): Promise<void> {
  await getEndpoint(db, accountId, endpointId);
  const ok = unwrap(await db.rpc("replay_webhook_delivery", { p_account: accountId, p_endpoint: endpointId, p_id: deliveryId }));
  if (ok !== true) throw new ApiError("conflict", "Só entregas com estado 'dead' deste webhook podem ser reenviadas", 409);
}

/** Enfileira um `webhook.test` só para este endpoint (valida URL, assinatura e resposta antes de ir para produção). */
export async function enqueueTest(db: Db, accountId: string, endpointId: string): Promise<{ delivery_id: string }> {
  await getEndpoint(db, accountId, endpointId);
  const eventId = randomUUID();
  const payload = {
    id: eventId,
    type: WEBHOOK_TEST_EVENT,
    created_at: new Date().toISOString(),
    account_id: accountId,
    data: { message: "Evento de teste do CRM DDM" },
  };
  const rows = unwrap(
    await db
      .from("webhook_deliveries")
      .insert({ account_id: accountId, endpoint_id: endpointId, event_id: eventId, event: WEBHOOK_TEST_EVENT, payload })
      .select("id")
      .limit(1),
  ) as Array<{ id: string }> | null;
  if (!rows?.[0]) throw new ApiError("internal", "Falha ao enfileirar o teste", 500);
  return { delivery_id: rows[0].id };
}
