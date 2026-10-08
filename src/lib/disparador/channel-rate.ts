// Limite por segundo por número (P1-4): regra PURA — qualidade da Meta → limite automático (com rampa) → limite efetivo (manual × automático).
// Funções puras (recebem política, linha e relógio): testáveis e usadas pelo cron (buildChannelWork), pela API de limites, pelo webhook/poll de saúde
// e pela previsão. Os valores padrão abaixo são os da política (tabela dispatch_rate_policy); aqui só servem de fallback quando a linha não existe.
//
// Regras do dono (não reabrir): verde 80/s, amarelo 40/s, vermelho 8/s (+ campanha nova exige confirmação do owner), desconhecido 5/s; sobe em RAMPA
// (+25% a cada 60 s), nunca salta para 80; descer é imediato; o sistema nunca sobe sozinho acima de um manual; se a qualidade piora e auto < manual,
// vale min(manual, auto) salvo force_above_quality (só owner); cooldown por rate limit reduz também o rate (metade). WAHA fora da regra.

export type Quality = "GREEN" | "YELLOW" | "RED" | "UNKNOWN";

export interface RatePolicy {
  green: number;
  yellow: number;
  red: number;
  unknown: number;
  /** Teto físico por número. */
  max: number;
  floor: number;
  rampPercent: number;
  rampIntervalSeconds: number;
  redRequiresOwnerConfirmation: boolean;
}

export const DEFAULT_RATE_POLICY: RatePolicy = {
  green: 80,
  yellow: 40,
  red: 8,
  unknown: 5,
  max: 80,
  floor: 1,
  rampPercent: 25,
  rampIntervalSeconds: 60,
  redRequiresOwnerConfirmation: true,
};

/** Linha de wacrm.dispatch_rate_policy → política (campos ausentes caem no padrão). */
export function policyFromRow(row: Record<string, unknown> | null | undefined): RatePolicy {
  const num = (key: string, fallback: number) => {
    const n = Number(row?.[key]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    green: num("green_rate", DEFAULT_RATE_POLICY.green),
    yellow: num("yellow_rate", DEFAULT_RATE_POLICY.yellow),
    red: num("red_rate", DEFAULT_RATE_POLICY.red),
    unknown: num("unknown_rate", DEFAULT_RATE_POLICY.unknown),
    max: num("max_rate_per_second", DEFAULT_RATE_POLICY.max),
    floor: num("floor_rate", DEFAULT_RATE_POLICY.floor),
    rampPercent: num("ramp_percent", DEFAULT_RATE_POLICY.rampPercent),
    rampIntervalSeconds: num("ramp_interval_seconds", DEFAULT_RATE_POLICY.rampIntervalSeconds),
    redRequiresOwnerConfirmation: row?.red_requires_owner_confirmation !== false,
  };
}

export function normalizeQuality(raw: unknown): Quality {
  const value = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return value === "GREEN" || value === "YELLOW" || value === "RED" ? value : "UNKNOWN";
}

const RANK: Record<Quality, number> = { GREEN: 3, YELLOW: 2, RED: 1, UNKNOWN: 0 };

/** A qualidade piorou? (UNKNOWN conta como a pior só quando vinha de uma cor conhecida.) */
export function isDowngrade(from: Quality | null | undefined, to: Quality): boolean {
  if (!from) return false;
  return RANK[to] < RANK[from];
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round2 = (value: number) => Math.round(value * 100) / 100;

/** Limite/s alvo pela qualidade (dentro de [piso, teto]). */
export function autoTargetRate(policy: RatePolicy, quality: Quality): number {
  const raw = quality === "GREEN" ? policy.green : quality === "YELLOW" ? policy.yellow : quality === "RED" ? policy.red : policy.unknown;
  return round2(clamp(raw, Math.min(policy.floor, policy.max), policy.max));
}

/** Estado salvo em dispatch_channel_rate (campos usados pela regra). */
export interface RateState {
  auto_rate_per_second: number;
  auto_ramp_from?: number | null;
  auto_ramp_started_at?: string | Date | null;
  manual_rate_per_second?: number | null;
  force_above_quality?: boolean | null;
}

const toMs = (value: string | Date | null | undefined): number | null => {
  if (!value) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};

/** Limite automático EFETIVO agora: o alvo, ou onde a rampa chegou (+rampPercent a cada rampIntervalSeconds a partir de `auto_ramp_from`). */
export function rampedAuto(state: RateState, policy: RatePolicy, nowMs: number): number {
  const target = Number(state.auto_rate_per_second);
  const from = state.auto_ramp_from == null ? null : Number(state.auto_ramp_from);
  const startedMs = toMs(state.auto_ramp_started_at);
  if (from === null || startedMs === null || !(from > 0) || from >= target) return target;
  const steps = Math.max(0, Math.floor((nowMs - startedMs) / (policy.rampIntervalSeconds * 1000)));
  const grown = from * Math.pow(1 + policy.rampPercent / 100, steps);
  return round2(Math.min(target, Math.max(from, grown)));
}

export interface AutoUpdate {
  auto_rate_per_second: number;
  auto_ramp_from: number | null;
  auto_ramp_started_at: string | null;
}

/**
 * Novo estado automático depois de uma leitura de qualidade.
 * - número novo (sem linha): começa em min(alvo, taxa "desconhecido") e sobe em rampa;
 * - alvo abaixo do efetivo atual: desce NA HORA (sem rampa);
 * - alvo acima do efetivo atual: sobe em rampa a partir do efetivo atual;
 * - alvo igual: preserva a rampa em andamento.
 */
export function nextAutoState(prev: RateState | null, target: number, policy: RatePolicy, nowMs: number): AutoUpdate {
  const iso = new Date(nowMs).toISOString();
  if (!prev) {
    const start = Math.min(target, Math.max(policy.floor, policy.unknown));
    return start >= target
      ? { auto_rate_per_second: target, auto_ramp_from: null, auto_ramp_started_at: null }
      : { auto_rate_per_second: target, auto_ramp_from: round2(start), auto_ramp_started_at: iso };
  }
  const current = rampedAuto(prev, policy, nowMs);
  if (target < current) return { auto_rate_per_second: target, auto_ramp_from: null, auto_ramp_started_at: null };
  if (target === Number(prev.auto_rate_per_second)) {
    return {
      auto_rate_per_second: target,
      auto_ramp_from: prev.auto_ramp_from == null ? null : Number(prev.auto_ramp_from),
      auto_ramp_started_at: prev.auto_ramp_started_at == null ? null : new Date(toMs(prev.auto_ramp_started_at) ?? nowMs).toISOString(),
    };
  }
  return { auto_rate_per_second: target, auto_ramp_from: round2(current), auto_ramp_started_at: iso };
}

export type RateSource = "auto" | "manual" | "manual_capped_by_quality";

export interface EffectiveRate {
  /** Limite/s a aplicar agora (já com cooldown e teto). */
  rate: number;
  source: RateSource;
  /** Automático efetivo agora (com rampa). */
  auto: number;
  /** Alvo automático pela qualidade (sem rampa). */
  target: number;
  ramping: boolean;
  inCooldown: boolean;
}

/**
 * Efetivo = manual ?? auto, com a trava de segurança: a menos que o owner marque force_above_quality, o manual nunca passa do automático
 * efetivo (qualidade ruim ou rampa em andamento) — o sistema nunca sobe sozinho acima de um manual, e nunca deixa um manual alto ignorar a qualidade.
 */
export function effectiveRate(state: RateState, policy: RatePolicy, nowMs: number, options: { inCooldown?: boolean } = {}): EffectiveRate {
  const target = Number(state.auto_rate_per_second);
  const auto = rampedAuto(state, policy, nowMs);
  const manual = state.manual_rate_per_second == null ? null : Number(state.manual_rate_per_second);
  let rate = auto;
  let source: RateSource = "auto";
  if (manual !== null && manual > 0) {
    if (state.force_above_quality) {
      rate = manual;
      source = "manual";
    } else if (manual <= auto) {
      rate = manual;
      source = "manual";
    } else {
      rate = auto;
      source = "manual_capped_by_quality";
    }
  }
  const inCooldown = options.inCooldown === true;
  // Cooldown por rate limit (130429/131048/131056/429): metade do limite/s, como já faz com as vagas.
  if (inCooldown) rate = rate / 2;
  rate = round2(clamp(rate, Math.min(policy.floor, rate), policy.max));
  return { rate, source, auto, target, ramping: auto < target, inCooldown };
}

/** Vagas (paralelismo) derivadas do limite/s: ceil(rate × p95 × 1,2), entre 1 e o teto. */
export function derivedSlots(rate: number, p95Seconds: number, ceiling: number): number {
  const raw = Math.ceil(rate * Math.max(0.05, p95Seconds) * 1.2);
  return clamp(raw, 1, Math.max(1, ceiling));
}

/** Telefone comparável: só dígitos (display_phone_number "+55 21 3030-9159" ≡ "552130309159"). */
export function phoneDigits(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\D/g, "") : "";
}

/** Limite diário do tier da Meta (null = ilimitado/desconhecido). */
const TIER_DAILY_LIMITS: Record<string, number | null> = {
  TIER_NOT_SET: 250,
  TIER_50: 50,
  TIER_250: 250,
  TIER_1K: 1000,
  TIER_2K: 2000,
  TIER_10K: 10_000,
  TIER_100K: 100_000,
  TIER_UNLIMITED: null,
  UNLIMITED: null,
};

export function dailyLimitForTier(tier: string | null | undefined): number | null {
  if (!tier) return null;
  return tier in TIER_DAILY_LIMITS ? TIER_DAILY_LIMITS[tier] : null;
}
