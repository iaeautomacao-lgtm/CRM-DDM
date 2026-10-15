import "server-only";
// Webhooks de saída do CICLO DE VIDA de campanha (API pública Onda 1, bloco B): campaign.started | paused | resumed | completed | cancelled.
// Emitidos em TypeScript, LOGO DEPOIS da RPC que mudou o estado (quem chama só emite com `changed: true`), pela fila já existente de
// webhooks de saída (enqueue_webhook_event: assinatura, retry/backoff, replay, só para quem assinou o tipo). A pausa AUTOMÁTICA continua
// sendo campaign.auto_paused (active-alerts.ts); aqui é só a manual (tela ou API).
// Melhor esforço: NUNCA lança e nunca atrasa o fluxo que originou o evento. Sem assinante, custo = 1 consulta (webhook_endpoint_listens).
// `event_id` determinístico: started/completed saem UMA vez por campanha; paused/resumed/cancelled por ocorrência (janela de 5 s, para que
// duas chamadas simultâneas da MESMA ação — tela e API — não dupliquem, e ações repetidas depois sim). Sem dado pessoal: só ids, nome da
// campanha, contagens e motivos.
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { loadCampaignStatusCounts, summarizeStatusCounts, type CampaignStatusCounts } from "@/lib/disparador/campaign-status-counts";
import type { WebhookEvent } from "./catalog";

type Db = Pick<SupabaseClient, "from" | "rpc">;

export type CampaignEventActor = "user" | "api" | "system";
export type CampaignLifecycleEvent = Extract<WebhookEvent, "campaign.started" | "campaign.paused" | "campaign.resumed" | "campaign.completed" | "campaign.cancelled">;

interface CampaignRow {
  id: string;
  nome: string | null;
  idempotency_key: string | null;
  source: string | null;
  status: string | null;
  session_ids: string[] | null;
  updated_at: string | null;
}

/** UUID determinístico (md5 em formato UUID, como o md5(...)::uuid dos triggers). */
export function deterministicEventId(parts: string): string {
  const hex = createHash("md5").update(parts).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const OCCURRENCE_WINDOW_MS = 5_000;
export const occurrenceKey = (nowMs: number = Date.now()) => String(Math.floor(nowMs / OCCURRENCE_WINDOW_MS));

export function lifecycleEventId(event: CampaignLifecycleEvent, campaignId: string, occurrence?: string): string {
  const once = event === "campaign.started" || event === "campaign.completed";
  return deterministicEventId(`${event}:${campaignId}:${once ? "once" : (occurrence ?? occurrenceKey())}`);
}

export interface CampaignSummary {
  total: number;
  sent: number;
  delivered: number;
  read: number;
  errors: number;
  blocked: number;
  cancelled: number;
}

/** Resumo da fila por status (mesmas contagens do callback antigo). `delivered` inclui os lidos; `sent` inclui entregues e lidos. */
export function summaryFromCounts(counts: CampaignStatusCounts): CampaignSummary {
  const s = summarizeStatusCounts(counts);
  const n = (k: string) => counts[k] ?? 0;
  return { total: s.total_enfileirados, sent: s.enviados, delivered: n("entregue") + n("lido"), read: n("lido"), errors: s.erros, blocked: s.bloqueados, cancelled: s.cancelados };
}

async function loadCampaign(db: Db, accountId: string, campaignId: string): Promise<CampaignRow | null> {
  const { data, error } = await db
    .from("campaigns")
    .select("id, nome, idempotency_key, source, status, session_ids, updated_at")
    .eq("id", campaignId)
    .eq("account_id", accountId)
    .limit(1);
  if (error) return null;
  return ((data ?? [])[0] as CampaignRow | undefined) ?? null;
}

async function providerOf(db: Db, accountId: string, sessionIds: string[] | null): Promise<string | null> {
  const first = (sessionIds ?? [])[0];
  if (!first) return null;
  const { data } = await db.from("whatsapp_config").select("provider").eq("account_id", accountId).eq("id", first).limit(1);
  return ((data ?? [])[0] as { provider?: string } | undefined)?.provider ?? null;
}

async function totalContacts(db: Db, campaignId: string): Promise<number | null> {
  const { data } = await db.from("campaign_metrics").select("total_contatos").eq("campaign_id", campaignId).limit(1);
  const v = ((data ?? [])[0] as { total_contatos?: number | string | null } | undefined)?.total_contatos;
  return v === undefined || v === null ? null : Number(v);
}

async function listens(db: Db, accountId: string, event: CampaignLifecycleEvent): Promise<boolean> {
  const { data, error } = await db.rpc("webhook_endpoint_listens", { p_account: accountId, p_event: event });
  // Sem a 204 (função inexistente) ou erro: não emite (nunca derruba o fluxo).
  return !error && data === true;
}

async function enqueue(db: Db, accountId: string, event: CampaignLifecycleEvent, eventId: string, data: Record<string, unknown>): Promise<number> {
  const { data: n, error } = await db.rpc("enqueue_webhook_event", { p_account: accountId, p_event: event, p_event_id: eventId, p_data: data });
  if (error) {
    console.error(`[webhooks-out] falha ao enfileirar ${event}:`, error.message);
    return 0;
  }
  return Number(n) || 0;
}

interface Base {
  accountId: string;
  campaignId: string;
  /** Quem agiu. Padrão: `user` (tela). */
  by?: CampaignEventActor;
  /** Identifica a ocorrência (padrão: janela de 5 s). Passe o mesmo valor em chamadas que representam a MESMA ação. */
  occurrence?: string;
}

/** Monta e enfileira um evento do ciclo de vida. Nunca lança; devolve quantas entregas criou (0 = sem assinante ou falha). */
async function emit(event: CampaignLifecycleEvent, input: Base, extra: (c: CampaignRow, db: Db) => Promise<Record<string, unknown>>, db: Db): Promise<number> {
  try {
    if (!(await listens(db, input.accountId, event))) return 0;
    const campaign = await loadCampaign(db, input.accountId, input.campaignId);
    if (!campaign) return 0;
    const data = {
      campaign_id: campaign.id,
      name: campaign.nome,
      external_id: campaign.idempotency_key,
      source: campaign.source,
      ...(await extra(campaign, db)),
    };
    return await enqueue(db, input.accountId, event, lifecycleEventId(event, input.campaignId, input.occurrence), data);
  } catch (err) {
    console.error(`[webhooks-out] ${event} não emitido:`, err instanceof Error ? err.message : "erro");
    return 0;
  }
}

/** campaign.started — criada pela API e ativada, ou iniciada pelo painel (startCampaign), uma vez por campanha. */
export function emitCampaignStarted(db: Db, input: Base): Promise<number> {
  return emit("campaign.started", input, async (c) => ({
    total_contacts: await totalContacts(db, c.id),
    provider: await providerOf(db, input.accountId, c.session_ids),
  }), db);
}

/** campaign.paused — pausa MANUAL (tela ou API). A automática é campaign.auto_paused. Chame só com changed:true. */
export function emitCampaignPaused(db: Db, input: Base & { reason?: string | null; itemsPendingMove?: boolean }): Promise<number> {
  return emit("campaign.paused", input, async () => ({
    automatic: false,
    by: input.by ?? "user",
    reason: input.reason ?? null,
    items_pending_move: input.itemsPendingMove ?? false,
  }), db);
}

/** campaign.resumed — retomada manual (tela ou API). Chame só com changed:true. */
export function emitCampaignResumed(db: Db, input: Base & { resumedItems?: number | null }): Promise<number> {
  return emit("campaign.resumed", input, async () => ({ by: input.by ?? "user", resumed_items: input.resumedItems ?? null }), db);
}

/** campaign.completed — a fila esgotou (complete_dispatch_campaign devolveu verdadeiro). Uma vez por campanha. */
export async function emitCampaignCompleted(db: Db, input: { accountId?: string | null; campaignId: string }): Promise<number> {
  let accountId = input.accountId ?? null;
  if (!accountId) {
    // Caminho sem a conta à mão (watchdog do cron): acha a conta da campanha.
    const { data } = await db.from("campaigns").select("account_id").eq("id", input.campaignId).limit(1);
    accountId = ((data ?? [])[0] as { account_id?: string } | undefined)?.account_id ?? null;
    if (!accountId) return 0;
  }
  const resolved = { accountId, campaignId: input.campaignId };
  return emit("campaign.completed", resolved, async (c) => {
    const counts = await loadCampaignStatusCounts(db, c.id);
    return { completed_at: c.updated_at, summary: counts ? summaryFromCounts(counts) : null };
  }, db);
}

/** campaign.cancelled — encerramento manual (tela `stop` ou API `cancel`). Chame só com changed:true. */
export function emitCampaignCancelled(db: Db, input: Base & { cancelledItems?: number | null; itemsPendingMove?: boolean; reason?: string | null }): Promise<number> {
  return emit("campaign.cancelled", input, async (c) => {
    const counts = await loadCampaignStatusCounts(db, c.id);
    return {
      by: input.by ?? "user",
      reason: input.reason ?? null,
      cancelled_items: input.cancelledItems ?? null,
      items_pending_move: input.itemsPendingMove ?? false,
      cancelled_at: c.updated_at,
      summary: counts ? summaryFromCounts(counts) : null,
    };
  }, db);
}
