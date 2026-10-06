// Redistribuição ("reflow") da fila de uma campanha em lote/"Segmentado"
// cujo agendamento não bate com a janela de envio.
//
// Regra do negócio: "o disparo que passar do horário continua no próximo dia
// útil, no mesmo intervalo de horas, mantendo o ritmo". Filas montadas antes
// do relógio de janela (PR #75) têm as rodadas espaçadas no relógio comum —
// ex.: uma rodada a cada 30 min atravessando a noite e o fim de semana. Na
// reabertura essas rodadas estão todas vencidas ao mesmo tempo.
//
// Quando o cron encontra, entre os itens vencidos de uma campanha em lote,
// algum agendado num período fechado (isScheduledInClosedWindow), a fila
// restante ('agendado') é recalculada UMA vez:
// - ordem preservada: (scheduled_at, id);
// - os itens do mesmo contato (sequência de mensagens) ficam juntos, em
//   ordem, a 3 s um do outro — igual ao startCampaign;
// - contatos agrupados em rodadas de batch_size, com o horário de cada
//   rodada dado por scheduleRounds (pausa medida em tempo ABERTO) a partir
//   de agora, + espalhamento de no máximo 2 s na rodada inteira
//   (roundSpreadOffsetMs, o mesmo do startCampaign).
// Depois do reflow todos os itens ficam em tempo aberto, então o detector
// volta a dar false — não há reflow repetido.
//
// Concorrência: roda dentro do lock do cron (try_acquire_cron_lock), e a
// gravação só altera itens ainda 'agendado' (RPC reflow_campaign_queue,
// migration 163, ou fallback com o mesmo filtro). Item já reivindicado
// ('enviando') ou pausado/cancelado no meio do caminho não é tocado.

import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { processWithConcurrency } from "@/lib/disparador/concurrency";
import {
  INTRA_CONTACT_MS,
  isScheduledInClosedWindow,
  roundContactTimeMs,
  scheduleRounds,
  type SendWindowConfig,
} from "@/lib/disparador/window-clock";

/**
 * Passo por posição das filas montadas ANTES do espalhamento limitado (100 ms
 * × posição). Só entra na tolerância de transbordo: filas antigas ainda
 * podem estar no banco.
 */
export const LEGACY_ROUND_JITTER_MS = 100;
/** Mesmo espaçamento do startCampaign entre mensagens do mesmo contato. */
export const REFLOW_INTRA_CONTACT_MS = INTRA_CONTACT_MS;
/** Tamanho de cada gravação (RPC ou fallback). */
export const REFLOW_CHUNK_SIZE = 500;
const PAGE_SIZE = 1000;

export interface ReflowSourceItem {
  id: string;
  contact_id: string | null;
  scheduled_at: string | null;
}

export interface ReflowAssignment {
  id: string;
  scheduled_at: string;
}

/**
 * Quanto um item de uma rodada pode legitimamente passar do fechamento:
 * rodada no último instante aberto + espalhamento da rodada inteira + folga
 * para sequências de mensagens. Itens dentro disso não disparam o reflow.
 * Usa o passo antigo (100 ms × posição), que cobre com sobra o espalhamento
 * novo (< 2 s) e as filas montadas antes dele.
 */
export function spillToleranceMs(batchSize: number): number {
  return Math.max(1, batchSize) * LEGACY_ROUND_JITTER_MS + 10 * 60_000;
}

/**
 * A fila precisa de reflow? Olha os itens VENCIDOS que o cron acabou de
 * buscar. Itens de retry (tentativas > 0) não contam: são avulsos, o
 * retry_transient_queue_errors os reagenda no relógio comum, e redistribuir
 * a campanha inteira por causa de um retry à noite mudaria o ritmo à toa.
 */
export function needsQueueReflow(
  dueItems: ReadonlyArray<{ scheduled_at?: string | null; tentativas?: number | null }>,
  janela: SendWindowConfig,
  batchSize: number
): boolean {
  if (batchSize <= 1) return false;
  const tolerance = spillToleranceMs(batchSize);
  return dueItems.some(
    (item) =>
      (item.tentativas ?? 0) === 0 &&
      !!item.scheduled_at &&
      isScheduledInClosedWindow(new Date(item.scheduled_at), janela, tolerance)
  );
}

/**
 * Calcula o novo scheduled_at de cada item. `items` deve vir ordenado por
 * (scheduled_at, id). Função pura.
 */
export function planQueueReflow(
  items: readonly ReflowSourceItem[],
  opts: { start: Date; batchSize: number; pauseSeconds: number; janela: SendWindowConfig }
): ReflowAssignment[] {
  const batchSize = Math.max(1, Math.floor(opts.batchSize));
  // Unidade = contato (todas as mensagens dele, em ordem). Item sem
  // contact_id (contato externo da API v1) é uma unidade sozinho.
  const units = new Map<string, string[]>();
  for (const item of items) {
    const key = item.contact_id ? `c:${item.contact_id}` : `i:${item.id}`;
    const unit = units.get(key);
    if (unit) unit.push(item.id);
    else units.set(key, [item.id]);
  }
  const unitList = [...units.values()];
  const roundTimes = scheduleRounds(
    opts.start,
    Math.ceil(unitList.length / batchSize),
    opts.pauseSeconds,
    opts.janela
  );
  const assignments: ReflowAssignment[] = [];
  unitList.forEach((ids, index) => {
    const base = roundContactTimeMs(roundTimes, index, batchSize, unitList.length);
    ids.forEach((id, j) => {
      assignments.push({
        id,
        scheduled_at: new Date(base + j * REFLOW_INTRA_CONTACT_MS).toISOString(),
      });
    });
  });
  return assignments;
}

function isMissingRpc(error: { code?: string; message?: string } | null, fn: string): boolean {
  if (!error) return false;
  if (error.code === "PGRST202" || error.code === "42883") return true;
  return (error.message ?? "").includes(fn) && /could not find|does not exist/i.test(error.message ?? "");
}

export interface ReflowCampaign {
  id: string;
  janela_inicio?: string | null;
  janela_fim?: string | null;
  dias_envio?: number[] | null;
  batch_size?: number | null;
  batch_pause_seconds?: number | null;
}

export type ReflowResult =
  | { ok: true; items: number; updated: number; via: "rpc" | "fallback" }
  | { ok: false; error: string };

/** Status de item que o reflow pode reagendar. */
export type ReflowQueueStatus = "agendado" | "pausado";

/** Itens da campanha no status, na ordem da fila: (scheduled_at, id). */
async function loadReflowItems(
  campaignId: string,
  status: ReflowQueueStatus
): Promise<{ ok: true; items: ReflowSourceItem[] } | { ok: false; error: string }> {
  const db = supabaseAdmin();
  const items: ReflowSourceItem[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from("disp_message_queue")
      .select("id, contact_id, scheduled_at")
      .eq("campaign_id", campaignId)
      .eq("status", status)
      .order("scheduled_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) return { ok: false, error: error.message };
    items.push(...((data ?? []) as ReflowSourceItem[]));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return { ok: true, items };
}

function planFor(campaign: ReflowCampaign, items: readonly ReflowSourceItem[], now: Date) {
  return planQueueReflow(items, {
    start: now,
    batchSize: campaign.batch_size ?? 1,
    pauseSeconds: campaign.batch_pause_seconds ?? 0,
    janela: { inicio: campaign.janela_inicio, fim: campaign.janela_fim, dias: campaign.dias_envio },
  });
}

/**
 * Grava os novos horários, só em itens ainda no `status` informado. Do FIM
 * para o começo: se parar no meio (erro/timeout), os itens não gravados são
 * os mais antigos e continuam antes dos já redistribuídos — a ordem nunca
 * inverte, e um novo reflow conserta o resto.
 */
async function writeReflowAssignments(
  campaignId: string,
  assignments: readonly ReflowAssignment[],
  status: ReflowQueueStatus
): Promise<{ ok: true; updated: number; via: "rpc" | "fallback" } | { ok: false; error: string }> {
  const db = supabaseAdmin();
  const chunks: ReflowAssignment[][] = [];
  for (let i = 0; i < assignments.length; i += REFLOW_CHUNK_SIZE)
    chunks.push(assignments.slice(i, i + REFLOW_CHUNK_SIZE));
  chunks.reverse();

  let updated = 0;
  let useFallback = false;
  for (const chunk of chunks) {
    if (!useFallback) {
      const { data, error } = await db.rpc("reflow_campaign_queue", {
        p_campaign_id: campaignId,
        p_items: chunk,
        p_status: status,
      });
      if (!error) {
        updated += typeof data === "number" ? data : 0;
        continue;
      }
      if (!isMissingRpc(error, "reflow_campaign_queue")) return { ok: false, error: error.message };
      // Migration 163 não aplicada: segue item a item com o mesmo filtro.
      useFallback = true;
    }
    const reversed = [...chunk].reverse();
    const state: { failure: string | null } = { failure: null };
    await processWithConcurrency(reversed, 8, async (assignment) => {
      if (state.failure) return;
      const { error } = await db
        .from("disp_message_queue")
        .update({ scheduled_at: assignment.scheduled_at })
        .eq("id", assignment.id)
        .eq("campaign_id", campaignId)
        .eq("status", status);
      if (error) state.failure = error.message;
      else updated++;
    });
    if (state.failure) return { ok: false, error: state.failure };
  }
  return { ok: true, updated, via: useFallback ? "fallback" : "rpc" };
}

/**
 * Redistribui a fila 'agendado' da campanha a partir de `now`. Deve ser
 * chamada com o lock do cron.
 */
export async function reflowCampaignQueue(
  campaign: ReflowCampaign,
  now: Date = new Date()
): Promise<ReflowResult> {
  const loaded = await loadReflowItems(campaign.id, "agendado");
  if (!loaded.ok) return loaded;
  if (loaded.items.length === 0) return { ok: true, items: 0, updated: 0, via: "rpc" };
  const written = await writeReflowAssignments(campaign.id, planFor(campaign, loaded.items, now), "agendado");
  if (!written.ok) return written;
  return { ok: true, items: loaded.items.length, updated: written.updated, via: written.via };
}

export type ResumeResult =
  | { ok: true; resumed: number }
  | { ok: false; reason: "state_changed" | "error"; error: string };

/**
 * Retomada de campanha em lote/"Segmentado" pausada. A RPC antiga
 * (resume_dispatch_campaign) põe TODOS os itens 'pausado' em 'agendado' com
 * scheduled_at = agora: a fila inteira vence junto e, como o lote não
 * reserva cadência (#68), o cron solta até 700 por tick — perde o ritmo.
 *
 * Agora, com a campanha ainda pausada (o cron não a toca):
 * 1. redistribui os itens 'pausado' a partir de agora (mesma regra do
 *    reflow: ordem da fila, rodadas de batch_size, pausa em tempo aberto);
 * 2. retoma com resume_dispatch_campaign_keep_schedule (migration 163),
 *    que troca o status sem mexer no scheduled_at, numa transação.
 * Sem a migration 163: retoma com a RPC antiga e regrava o mesmo plano nos
 * itens já 'agendado' (a ordem vem do passo 1, não do scheduled_at = agora;
 * janela curta em que um tick do cron pode adiantar parte da fila).
 * Falha no passo 1 = campanha continua pausada (pode tentar de novo).
 */
export async function resumeBatchedCampaign(
  campaign: ReflowCampaign,
  accountId: string,
  now: Date = new Date()
): Promise<ResumeResult> {
  const db = supabaseAdmin();
  const loaded = await loadReflowItems(campaign.id, "pausado");
  if (!loaded.ok) return { ok: false, reason: "error", error: loaded.error };
  const plan = planFor(campaign, loaded.items, now);
  if (plan.length > 0) {
    const written = await writeReflowAssignments(campaign.id, plan, "pausado");
    if (!written.ok) return { ok: false, reason: "error", error: written.error };
  }

  const args = { p_campaign_id: campaign.id, p_account_id: accountId };
  const keep = await db.rpc("resume_dispatch_campaign_keep_schedule", args);
  if (!keep.error) {
    if (keep.data === null) return { ok: false, reason: "state_changed", error: "Estado da campanha mudou" };
    return { ok: true, resumed: Number(keep.data) };
  }
  if (!isMissingRpc(keep.error, "resume_dispatch_campaign_keep_schedule"))
    return { ok: false, reason: "error", error: keep.error.message };

  const legacy = await db.rpc("resume_dispatch_campaign", args);
  if (legacy.error) return { ok: false, reason: "error", error: legacy.error.message };
  if (legacy.data === null) return { ok: false, reason: "state_changed", error: "Estado da campanha mudou" };
  if (plan.length > 0) {
    const rewritten = await writeReflowAssignments(campaign.id, plan, "agendado");
    // Campanha já retomada: não dá para desfazer. Só registra — é o
    // comportamento antigo (fila toda vencida), limitado ao caminho sem a
    // migration 163.
    if (!rewritten.ok) console.error("[resumeBatchedCampaign] Falha ao regravar o ritmo:", rewritten.error);
  }
  return { ok: true, resumed: Number(legacy.data) };
}
