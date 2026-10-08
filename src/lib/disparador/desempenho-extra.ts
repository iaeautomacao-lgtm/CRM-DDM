// Desempenho (P1-8): leitura completa da janela (sem o corte de 1000 linhas do PostgREST), estatística
// por número a partir do cron_tick e capacidade teórica × real. Funções puras ou com `db` injetável.

import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateThroughputPerMinute } from "./dispatch-forecast";
import type {
  ChannelInfo,
  CronTickPayload,
  RawSystemLogTick,
  RawThroughputRow,
  ThroughputDataPoint,
} from "./desempenho";

type Db = Pick<SupabaseClient, "from">;

/** O PostgREST corta cada resposta em 1000 linhas (max-rows do Supabase). */
export const PAGE_SIZE = 1000;
/** 8 páginas = 8.000 ticks (24 h de ticks encadeados cabem com folga; 1 tick/min = 1.440). */
export const MAX_TICK_PAGES = 8;
/** 12 páginas = 12.000 pontos (24 h × 8 números = 11.520). */
export const MAX_THROUGHPUT_PAGES = 12;

export interface FetchedTicks {
  rows: RawSystemLogTick[];
  /** true se parou no teto de páginas com a janela ainda não coberta. */
  truncated: boolean;
}

/**
 * cron_tick da janela, mais recente primeiro, paginado por .range(). Antes: `.limit(1000)` cortava a
 * janela de 24 h em ~16,7 h (1.440 ticks) e as métricas/médias cobriam só os 1000 mais recentes.
 */
export async function fetchAllTicks(db: Db, startIso: string, maxPages = MAX_TICK_PAGES): Promise<FetchedTicks> {
  const rows: RawSystemLogTick[] = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await db
      .from("system_logs")
      .select("id, created_at, payload")
      .eq("source", "disparador")
      .eq("event", "cron_tick")
      .gte("created_at", startIso)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const chunk = (data ?? []) as RawSystemLogTick[];
    rows.push(...chunk);
    if (chunk.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export interface FetchedThroughput {
  rows: RawThroughputRow[];
  truncated: boolean;
  /** false = a view não existe/falhou (usar os ticks). */
  available: boolean;
}

/**
 * Vazão por minuto por número (view da 164), em ORDEM DECRESCENTE de minuto e paginada: antes a leitura
 * era crescente e sem limite — acima de 1000 linhas o PostgREST cortava justamente os minutos MAIS RECENTES.
 * Devolve em ordem cronológica.
 */
export async function fetchThroughputRows(
  db: Db,
  startIso: string,
  sessionIds: string[],
  maxPages = MAX_THROUGHPUT_PAGES,
): Promise<FetchedThroughput> {
  if (sessionIds.length === 0) return { rows: [], truncated: false, available: true };
  const rows: RawThroughputRow[] = [];
  let truncated = true;
  for (let page = 0; page < maxPages; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await db
      .from("dispatch_throughput_per_minute")
      .select("session_id, minute, sent")
      .in("session_id", sessionIds)
      .gte("minute", startIso)
      .order("minute", { ascending: false })
      .order("session_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) return { rows: [], truncated: false, available: false };
    const chunk = (data ?? []) as RawThroughputRow[];
    rows.push(...chunk);
    if (chunk.length < PAGE_SIZE) {
      truncated = false;
      break;
    }
  }
  rows.reverse();
  return { rows, truncated, available: true };
}

// ── Por número (channels{} do cron_tick) ─────────────────────────────────

export interface ChannelStats {
  id: string;
  label: string;
  provider: "meta" | "waha" | "unknown";
  ticks: number;
  sent: number;
  failed: number;
  deferred: number;
  blocked: number;
  pendingConfirmation: number;
  notStarted: number;
  peakInFlight: number;
  /** Maior concorrência configurada (início do tick) e menor ao fim (freio). */
  concurrencyStart: number | null;
  concurrencyEndMin: number | null;
  /** Ticks em que o número estava em cooldown. */
  cooldownTicks: number;
  /** Ticks em que a concorrência do número terminou menor que começou (freio). */
  brakeTicks: number;
}

/** Soma o `channels{}` dos ticks por número — SÓ dos canais da conta (o cron_tick é de todo o motor). */
export function aggregateChannelStats(
  ticks: readonly RawSystemLogTick[],
  channels: ReadonlyMap<string, ChannelInfo>,
): ChannelStats[] {
  const stats = new Map<string, ChannelStats>();
  for (const info of channels.values()) {
    stats.set(info.id, {
      id: info.id,
      label: info.label,
      provider: info.provider,
      ticks: 0,
      sent: 0,
      failed: 0,
      deferred: 0,
      blocked: 0,
      pendingConfirmation: 0,
      notStarted: 0,
      peakInFlight: 0,
      concurrencyStart: null,
      concurrencyEndMin: null,
      cooldownTicks: 0,
      brakeTicks: 0,
    });
  }
  for (const tick of ticks) {
    for (const [id, c] of Object.entries(tick.payload?.channels ?? {})) {
      const s = stats.get(id);
      if (!s) continue; // canal de outra conta
      s.ticks++;
      s.sent += c.sent ?? 0;
      s.failed += c.failed ?? 0;
      s.deferred += c.deferred ?? 0;
      s.blocked += c.blocked ?? 0;
      s.pendingConfirmation += c.pending_confirmation ?? 0;
      s.notStarted += c.not_started ?? 0;
      s.peakInFlight = Math.max(s.peakInFlight, c.peak_in_flight ?? 0);
      if (c.concurrency_start != null) s.concurrencyStart = Math.max(s.concurrencyStart ?? 0, c.concurrency_start);
      if (c.concurrency_end != null) s.concurrencyEndMin = Math.min(s.concurrencyEndMin ?? c.concurrency_end, c.concurrency_end);
      if (c.in_cooldown) s.cooldownTicks++;
      if (c.concurrency_start != null && c.concurrency_end != null && c.concurrency_end < c.concurrency_start) s.brakeTicks++;
    }
  }
  return [...stats.values()].filter((s) => s.ticks > 0).sort((a, b) => b.sent - a.sent);
}

// ── Capacidade teórica × real ────────────────────────────────────────────

export interface Capacity {
  /** Vagas simultâneas por número usadas no cálculo (min entre o padrão por número e o teto global). */
  slotsPerNumber: number | null;
  globalConcurrency: number | null;
  latencySeconds: number;
  budgetSeconds: number;
  /** vagas ÷ latência × orçamento do tick, em envios/min POR NÚMERO. */
  theoreticalPerMinPerNumber: number | null;
  /** Envios/min médios e de pico observados na janela (todos os números da conta). */
  realAvgPerMin: number;
  realPeakPerMin: number;
  /** Pico real ÷ teto teórico (por número, usando o número mais ativo), em %. */
  utilizationPct: number | null;
  /** Vagas necessárias por número para 80 envios/s (4.800/min) à latência atual e duty do tick. */
  slotsFor80PerSecond: number | null;
  /** Vagas de 80/s acima do teto de 50 do código atual. */
  above50SlotCap: boolean;
}

export const TARGET_PER_SECOND = 80;

export function computeCapacity(params: {
  latest: CronTickPayload | null | undefined;
  series: readonly ThroughputDataPoint[];
  /** Maior envio/min de um ÚNICO número na janela (para a utilização). */
  peakPerNumber: number;
  tickPeriodSeconds?: number;
}): Capacity {
  const { latest, series } = params;
  const knobs = latest?.knobs;
  const metaAvgMs = latest?.latency?.meta?.avg_ms ?? 0;
  const latencySeconds = metaAvgMs > 0 ? metaAvgMs / 1000 : 0.85;
  const budgetSeconds = (latest?.budget_ms ?? 35_000) / 1000;
  const slotsPerNumber = knobs ? Math.max(1, Math.min(knobs.per_number.meta, knobs.global_concurrency)) : null;
  const theoretical = slotsPerNumber === null ? null : Math.round(calculateThroughputPerMinute(slotsPerNumber, latencySeconds, budgetSeconds));
  const totals = series.map((p) => p.total);
  const realAvg = totals.length ? Math.round(totals.reduce((s, n) => s + n, 0) / totals.length) : 0;
  const realPeak = totals.length ? Math.max(...totals) : 0;
  // Para 80/s o tick precisaria estar ativo o minuto todo (duty = orçamento ÷ período do tick).
  const period = params.tickPeriodSeconds ?? 60;
  const duty = Math.min(1, budgetSeconds / period);
  const slotsFor80 = Math.ceil((TARGET_PER_SECOND * latencySeconds) / duty);
  return {
    slotsPerNumber,
    globalConcurrency: knobs?.global_concurrency ?? null,
    latencySeconds: Math.round(latencySeconds * 1000) / 1000,
    budgetSeconds,
    theoreticalPerMinPerNumber: theoretical,
    realAvgPerMin: realAvg,
    realPeakPerMin: realPeak,
    utilizationPct: theoretical ? Math.round((params.peakPerNumber / theoretical) * 100) : null,
    slotsFor80PerSecond: slotsFor80,
    above50SlotCap: slotsFor80 > 50,
  };
}

/** Maior envio/min de um único número na série (colunas além de minute/displayTime/total). */
export function peakPerNumber(series: readonly ThroughputDataPoint[]): number {
  let peak = 0;
  for (const point of series) {
    for (const [key, value] of Object.entries(point)) {
      if (key === "minute" || key === "displayTime" || key === "total") continue;
      if (typeof value === "number" && value > peak) peak = value;
    }
  }
  return peak;
}
