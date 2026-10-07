// Claim EM LOTE (migration 188, P1-3b): em vez de 1 RPC por item (claim_dispatch_item_capped) e um SELECT paginado por OFFSET para achar
// candidatos, o cron planeja "fichas" (quantos itens vencidos há por campanha×número, count_due_dispatch_items) e cada número reivindica
// os itens de verdade em lotes pequenos, just-in-time, com claim_dispatch_batch (FOR UPDATE SKIP LOCKED; max_in_flight, cotas e
// limite_por_hora checados 1× por lote — mesma regra do claim por item).
//
// Segurança do reservado: o lote pedido nunca passa das vagas livres do número (o agendador passa `free`), então tudo que foi reivindicado
// começa a enviar na hora. O que sobrar no buffer no fim do tick (orçamento esgotado) volta a 'agendado' (unclaim_dispatch_items).
//
// DISPARADOR_BATCH_CLAIM=1 liga (padrão: desligado, caminho por item); sem as RPCs da 188 o cron cai sozinho no caminho por item.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { QueueItem } from "@/lib/disparador/processQueue";
import type { BlacklistLookup } from "@/lib/disparador/tick-preload";

type Db = Pick<SupabaseClient, "rpc">;
type Env = Record<string, string | undefined>;

/** Lote máximo por claim (cada claim cabe nas vagas livres do número). */
export const BATCH_CLAIM_MAX = 50;

export function isBatchClaimEnabled(env: Env = process.env): boolean {
  const raw = (env.DISPARADOR_BATCH_CLAIM ?? "").trim().toLowerCase();
  // DESLIGADO por padrão: só liga com DISPARADOR_BATCH_CLAIM=1 depois de validado na bancada (#132)
  // num Postgres real — a exclusão entre claims concorrentes não é provada no PGlite (1 conexão).
  return raw === "1" || raw === "true" || raw === "on";
}

export function isMissingRpc(error: { code?: string } | null | undefined): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

/** Ficha do planejamento: ocupa uma vaga no agendador; o item real vem do claim em lote. */
export function makeClaimToken(campaignId: string, sessionId: string, index: number, nowIso: string): QueueItem {
  return {
    id: `token:${campaignId}:${sessionId}:${index}`,
    campaign_id: campaignId,
    session_id: sessionId,
    contact_id: null,
    tipo: "texto",
    mensagem_final: "",
    scheduled_at: nowIso,
    tentativas: 0,
  } as QueueItem;
}

export function isClaimToken(item: { id: string }): boolean {
  return item.id.startsWith("token:");
}

export interface DueCount {
  campaign_id: string;
  session_id: string | null;
  n: number;
}

/** Fichas de uma campanha: uma por item vencido (até `limit`), agrupadas por número. null = RPC indisponível (usar o caminho por item). */
export async function planClaimTokens(
  db: Db,
  campaignId: string,
  limit: number,
  nowIso: string = new Date().toISOString(),
): Promise<{ tokens: QueueItem[]; due: number } | null> {
  const { data, error } = await db.rpc("count_due_dispatch_items", { p_campaign_ids: [campaignId], p_limit: limit });
  if (error) {
    if (isMissingRpc(error)) return null;
    throw new Error(error.message);
  }
  // Resposta que não é a lista esperada (RPC ausente/diferente): usa o caminho por item.
  if (!Array.isArray(data)) return null;
  const tokens: QueueItem[] = [];
  for (const row of data as DueCount[]) {
    if (!row.session_id) continue; // item sem número não é reivindicável (igual ao claim por item)
    for (let i = 0; i < row.n; i++) tokens.push(makeClaimToken(row.campaign_id, row.session_id, i, nowIso));
  }
  return { tokens, due: tokens.length };
}

export interface ClaimedItem {
  item: QueueItem;
  /** Blacklist pré-carregada para ESTE lote (uma RPC por lote), quando disponível. */
  blacklistLookup: BlacklistLookup | undefined;
}

interface SlotState {
  buffer: ClaimedItem[];
  pending: Promise<void> | null;
  exhausted: boolean;
}

export interface ChannelClaimerDeps {
  db: Db;
  /** Padrão de max_in_flight do canal quando não há linha em dispatch_channel_limits (undefined = padrão do banco). */
  defaultMaxInFlight: (channelId: string) => number | undefined;
  /** Pré-carrega a blacklist dos itens do lote (tick-preload). */
  preload?: (items: QueueItem[]) => Promise<BlacklistLookup | undefined>;
  maxBatch?: number;
}

/**
 * Reivindica itens em lote por (número, campanha) e os entrega um a um. Vários `next` concorrentes do mesmo número esperam UM claim em voo
 * (single-flight). Quando o claim volta vazio o par fica "esgotado" no tick (cota/limite/fila vazia) — as fichas restantes viram no-op.
 */
export class ChannelClaimer {
  private readonly states = new Map<string, SlotState>();
  private claimedTotal = 0;
  private batches = 0;

  constructor(private readonly deps: ChannelClaimerDeps) {}

  private state(channelId: string, campaignId: string): SlotState {
    const key = `${channelId}|${campaignId}`;
    let s = this.states.get(key);
    if (!s) this.states.set(key, (s = { buffer: [], pending: null, exhausted: false }));
    return s;
  }

  async next(channelId: string, campaignId: string, free: number): Promise<ClaimedItem | null> {
    const state = this.state(channelId, campaignId);
    for (;;) {
      const ready = state.buffer.shift();
      if (ready) return ready;
      if (state.exhausted) return null;
      if (!state.pending) {
        state.pending = this.refill(state, channelId, campaignId, free).finally(() => {
          state.pending = null;
        });
      }
      await state.pending;
    }
  }

  private async refill(state: SlotState, channelId: string, campaignId: string, free: number): Promise<void> {
    const n = Math.min(this.deps.maxBatch ?? BATCH_CLAIM_MAX, Math.max(1, Math.floor(free)));
    const { data, error } = await this.deps.db.rpc("claim_dispatch_batch", {
      p_session_id: channelId,
      p_n: n,
      p_campaign_ids: [campaignId],
      p_default_max_in_flight: this.deps.defaultMaxInFlight(channelId) ?? null,
    });
    if (error) throw new Error(error.message);
    const items = ((data ?? []) as Array<{ item: QueueItem }>).map((row) => row.item).filter(Boolean);
    if (items.length === 0) {
      state.exhausted = true;
      return;
    }
    this.batches++;
    this.claimedTotal += items.length;
    let blacklistLookup: BlacklistLookup | undefined;
    try {
      blacklistLookup = await this.deps.preload?.(items);
    } catch {
      blacklistLookup = undefined; // cada envio consulta a blacklist (falha fechada lá)
    }
    for (const item of items) state.buffer.push({ item, blacklistLookup });
  }

  /** Itens reivindicados que não chegaram a ser entregues ao envio: voltam a 'agendado'. */
  async releaseLeftovers(): Promise<number> {
    const ids: string[] = [];
    for (const state of this.states.values()) {
      for (const claimed of state.buffer.splice(0)) ids.push(claimed.item.id);
    }
    if (ids.length === 0) return 0;
    const { data, error } = await this.deps.db.rpc("unclaim_dispatch_items", { p_ids: ids });
    if (error) {
      console.error("[Cron] Falha ao devolver itens reivindicados e não enviados:", error.message);
      return 0;
    }
    return Number(data) || 0;
  }

  stats(): { claimed: number; batches: number } {
    return { claimed: this.claimedTotal, batches: this.batches };
  }
}
