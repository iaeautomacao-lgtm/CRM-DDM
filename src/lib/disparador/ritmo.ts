import type { ThroughputConfig } from "@/lib/disparador/throughput-config";

// ============================================================
// Métricas de ritmo e limites ativos do motor de disparo.
//
// Lê os registros de telemetria (system_logs event='cron_tick') das
// últimas 24 horas para extrair a latência real de envio da Meta e do
// WAHA, além dos limites vigentes (knobs do cron_tick mais recente).
//
// Se não houver dados gravados, aplica padrões seguros:
// - Meta: 0,85 s de latência média
// - WAHA: 2,0 s de latência média
// ============================================================

export interface RitmoLimites {
  global_concurrency: number;
  per_number: {
    meta: number;
    waha: number;
  };
  budget_ms: number;
  budget_seconds: number;
}

export interface ProviderLatencySummary {
  avg_s: number;
  p95_s: number;
  has_data: boolean;
}

export interface RitmoResponse {
  ok: boolean;
  limites: RitmoLimites;
  latencia: {
    meta: ProviderLatencySummary;
    waha: ProviderLatencySummary;
  };
  refreshed_at: string;
  /** Menor limite/s efetivo entre os números Meta da conta (P1-4). Ausente/null = sem limite por segundo configurado. */
  meta_rate_per_second?: number | null;
}

export interface RawSystemLogTick {
  id: string;
  created_at: string;
  payload: {
    budget_ms?: number;
    knobs?: {
      global_concurrency?: number;
      per_number?: { meta?: number; waha?: number };
      budget_ms?: number;
    };
    effective_concurrency?: {
      global_end?: number;
    };
    latency?: {
      meta?: { count?: number; avg_ms?: number; p95_ms?: number };
      waha?: { count?: number; avg_ms?: number; p95_ms?: number };
    };
  } | null;
}

export const SAFE_DEFAULT_LATENCY = {
  meta: { avg_s: 0.85, p95_s: 1.2 },
  waha: { avg_s: 2.0, p95_s: 2.5 },
} as const;

export const SAFE_DEFAULT_LIMITS: RitmoLimites = {
  global_concurrency: 4,
  per_number: { meta: 4, waha: 4 },
  budget_ms: 35000,
  budget_seconds: 35,
};

/**
 * Calcula o consolidado de ritmo das últimas 24h a partir dos cron_ticks.
 * Função pura e desacoplada do banco.
 */
export function computeRitmo(
  ticks: RawSystemLogTick[],
  fallbackConfig?: Partial<ThroughputConfig>
): RitmoResponse {
  const latestTick = ticks[0]?.payload;

  const globalConcurrency =
    latestTick?.knobs?.global_concurrency ??
    latestTick?.effective_concurrency?.global_end ??
    fallbackConfig?.globalConcurrency ??
    SAFE_DEFAULT_LIMITS.global_concurrency;

  const perNumberMeta =
    latestTick?.knobs?.per_number?.meta ??
    fallbackConfig?.perNumber?.meta ??
    SAFE_DEFAULT_LIMITS.per_number.meta;

  const perNumberWaha =
    latestTick?.knobs?.per_number?.waha ??
    fallbackConfig?.perNumber?.waha ??
    SAFE_DEFAULT_LIMITS.per_number.waha;

  const budgetMs =
    latestTick?.budget_ms ??
    latestTick?.knobs?.budget_ms ??
    fallbackConfig?.tickBudgetMs ??
    SAFE_DEFAULT_LIMITS.budget_ms;

  const budgetSeconds = Math.max(1, Math.round(budgetMs / 1000));

  // Agrega latência das últimas 24h
  let metaTotalCount = 0;
  let metaAvgSum = 0;
  let metaP95Sum = 0;
  let metaTicksWithP95 = 0;

  let wahaTotalCount = 0;
  let wahaAvgSum = 0;
  let wahaP95Sum = 0;
  let wahaTicksWithP95 = 0;

  for (const t of ticks) {
    const p = t.payload;
    if (!p?.latency) continue;

    // Meta
    const meta = p.latency.meta;
    if (meta && (meta.count ?? 0) > 0 && (meta.avg_ms ?? 0) > 0) {
      metaTotalCount += meta.count!;
      metaAvgSum += meta.avg_ms! * meta.count!;
      if ((meta.p95_ms ?? 0) > 0) {
        // p95 ponderado pelo nº de envios do tick (F27): tick com 3 envios não pesa como tick com 3.000.
        metaP95Sum += meta.p95_ms! * meta.count!;
        metaTicksWithP95 += meta.count!;
      }
    }

    // WAHA
    const waha = p.latency.waha;
    if (waha && (waha.count ?? 0) > 0 && (waha.avg_ms ?? 0) > 0) {
      wahaTotalCount += waha.count!;
      wahaAvgSum += waha.avg_ms! * waha.count!;
      if ((waha.p95_ms ?? 0) > 0) {
        wahaP95Sum += waha.p95_ms! * waha.count!;
        wahaTicksWithP95 += waha.count!;
      }
    }
  }

  // Meta latency
  const metaAvgMs = metaTotalCount > 0 ? metaAvgSum / metaTotalCount : 0;
  const metaP95Ms = metaTicksWithP95 > 0 ? metaP95Sum / metaTicksWithP95 : 0;

  const metaAvgS =
    metaTotalCount > 0
      ? Math.round((metaAvgMs / 1000) * 100) / 100
      : SAFE_DEFAULT_LATENCY.meta.avg_s;
  const metaP95S =
    metaTicksWithP95 > 0
      ? Math.round((metaP95Ms / 1000) * 100) / 100
      : SAFE_DEFAULT_LATENCY.meta.p95_s;

  // WAHA latency
  const wahaAvgMs = wahaTotalCount > 0 ? wahaAvgSum / wahaTotalCount : 0;
  const wahaP95Ms = wahaTicksWithP95 > 0 ? wahaP95Sum / wahaTicksWithP95 : 0;

  const wahaAvgS =
    wahaTotalCount > 0
      ? Math.round((wahaAvgMs / 1000) * 100) / 100
      : SAFE_DEFAULT_LATENCY.waha.avg_s;
  const wahaP95S =
    wahaTicksWithP95 > 0
      ? Math.round((wahaP95Ms / 1000) * 100) / 100
      : SAFE_DEFAULT_LATENCY.waha.p95_s;

  return {
    ok: true,
    limites: {
      global_concurrency: globalConcurrency,
      per_number: {
        meta: perNumberMeta,
        waha: perNumberWaha,
      },
      budget_ms: budgetMs,
      budget_seconds: budgetSeconds,
    },
    latencia: {
      meta: {
        avg_s: metaAvgS,
        p95_s: Math.max(metaAvgS, metaP95S),
        has_data: metaTotalCount > 0,
      },
      waha: {
        avg_s: wahaAvgS,
        p95_s: Math.max(wahaAvgS, wahaP95S),
        has_data: wahaTotalCount > 0,
      },
    },
    refreshed_at: new Date().toISOString(),
  };
}

/**
 * Extrai os parâmetros prontos para a previsão (dispatch-forecast)
 * para um provedor específico.
 */
export function resolveProviderThroughput(
  ritmo: RitmoResponse,
  provider: "meta" | "waha" | null,
  /** Números (canais) ativos da campanha no provedor: os limites por número SOMAM, até o teto global. Padrão 1. */
  channels = 1,
): {
  slots: number;
  budgetSeconds: number;
  latency: { otimista: number; conservador: number };
  /** Limite/s efetivo (só Meta; WAHA fica fora da regra). Ausente = sem limite por segundo. */
  ratePerSecond?: number;
} {
  const p = provider === "waha" ? "waha" : "meta";
  const perNumber = ritmo.limites.per_number[p] ?? 4;
  const slots = Math.min(perNumber * Math.max(1, Math.floor(channels)), ritmo.limites.global_concurrency);
  const budgetSeconds = ritmo.limites.budget_seconds;
  const lat = ritmo.latencia[p];

  return {
    slots: Math.max(1, slots),
    budgetSeconds: Math.max(1, budgetSeconds),
    latency: {
      otimista: lat.avg_s,
      conservador: Math.max(lat.avg_s, lat.p95_s),
    },
    ...(p === "meta" && typeof ritmo.meta_rate_per_second === "number" && ritmo.meta_rate_per_second > 0
      ? { ratePerSecond: ritmo.meta_rate_per_second }
      : {}),
  };
}
