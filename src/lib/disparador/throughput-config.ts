import { resolveDispatchProcessConcurrency } from "@/lib/disparador/concurrency";

// ============================================================
// Botões de vazão do disparador (cron /api/disparador/cron).
//
// Todos os padrões reproduzem o comportamento anterior ao agendador por
// número: DISPATCH_PROCESS_CONCURRENCY envios simultâneos no processo
// (padrão 4), até 4 por número (o teto do claim no banco) e orçamento de
// 35s por tick (40s de deadline − 5s sem trabalho novo).
// Subir um botão é decisão operacional explícita; o código só DESCE a
// concorrência sozinho (backoff adaptativo), nunca passa dos botões.
//
// Variáveis (todas opcionais):
//   DISPATCH_PROCESS_CONCURRENCY           (4, máx. 50) teto global de envios
//                                          em andamento no processo (PR #73)
//   DISPARADOR_PER_NUMBER_CONCURRENCY      (4)    por número, padrão genérico
//   DISPARADOR_PER_NUMBER_CONCURRENCY_META (= genérico)
//   DISPARADOR_PER_NUMBER_CONCURRENCY_WAHA (= genérico, mas nunca acima de 4
//                                          sem ser definido explicitamente —
//                                          risco de banimento na WAHA)
//   DISPARADOR_TICK_BUDGET_MS              (35000) sem envio novo depois disso
//   DISPARADOR_ADAPTIVE_BACKOFF            (ligado; "0"/"false" desliga)
//   DISPARADOR_MAX_EVENT_LOOP_LAG_MS       (200)  p99 acima disso → reduz global
//   DISPARADOR_MAX_RSS_MB                  (1024) RSS acima disso → reduz global
//   DISPARADOR_BACKOFF_COOLDOWN_SECONDS    (300)  número fica com metade da
//                                          concorrência nos ticks seguintes
//
// Por número, wacrm.dispatch_channel_limits.max_in_flight (quando a linha
// existe) tem precedência sobre as variáveis — é o ajuste fino por canal e
// também o teto atômico do claim no banco.
//
// Como subir com segurança (um passo por vez, observando os logs
// system_logs event='cron_tick' por pelo menos 1 dia útil de disparo):
//   1. Meta, por número: linha em dispatch_channel_limits (max_in_flight
//      4→8→12) ou DISPARADOR_PER_NUMBER_CONCURRENCY_META, com a migration
//      164 aplicada (sem ela o banco continua limitando a 4 por número).
//   2. Global: DISPATCH_PROCESS_CONCURRENCY 8→16→24, só quando vários
//      números estiverem ativos ao mesmo tempo (com 1 número, o teto do
//      número é que manda).
//   3. A cada passo, conferir no cron_tick: duration_ms perto do orçamento,
//      event_loop_lag_p99_ms < 100, rss_mb estável, latency.*.p95_ms sem
//      subir, provider_errors sem 429/131048/131056 e backoff_events vazio.
//      Se houver backoff recorrente, volte um passo.
//   4. WAHA: manter 1–4. Só suba com DISPARADOR_PER_NUMBER_CONCURRENCY_WAHA
//      ou max_in_flight do canal, um número de cada vez.
// ============================================================

/** Valor que wacrm.claim_dispatch_item usa quando o canal não tem linha. */
export const DB_DEFAULT_MAX_IN_FLIGHT = 4;
/** Faixa aceita por dispatch_channel_limits.max_in_flight (CHECK). */
export const MAX_PER_NUMBER_CONCURRENCY = 50;

export type DispatchProvider = "meta" | "waha";

export interface ThroughputConfig {
  globalConcurrency: number;
  perNumber: { meta: number; waha: number; unknown: number };
  tickBudgetMs: number;
  adaptiveBackoff: boolean;
  maxEventLoopLagMs: number;
  maxRssMb: number;
  cooldownSeconds: number;
}

type Env = Record<string, string | undefined>;

function readInt(env: Env, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveThroughputConfig(env: Env = process.env): ThroughputConfig {
  const generic = clamp(
    readInt(env, "DISPARADOR_PER_NUMBER_CONCURRENCY") ?? DB_DEFAULT_MAX_IN_FLIGHT,
    1,
    MAX_PER_NUMBER_CONCURRENCY
  );
  const meta = clamp(
    readInt(env, "DISPARADOR_PER_NUMBER_CONCURRENCY_META") ?? generic,
    1,
    MAX_PER_NUMBER_CONCURRENCY
  );
  // WAHA não herda um aumento do genérico: subir acima de 4 (o efetivo de
  // hoje) exige a variável própria ou max_in_flight no canal.
  const waha = clamp(
    readInt(env, "DISPARADOR_PER_NUMBER_CONCURRENCY_WAHA") ??
      Math.min(generic, DB_DEFAULT_MAX_IN_FLIGHT),
    1,
    MAX_PER_NUMBER_CONCURRENCY
  );
  const backoffFlag = (env.DISPARADOR_ADAPTIVE_BACKOFF ?? "").trim().toLowerCase();
  return {
    // Mesmo botão do pool antigo (PR #73): DISPATCH_PROCESS_CONCURRENCY.
    globalConcurrency: resolveDispatchProcessConcurrency(env.DISPATCH_PROCESS_CONCURRENCY),
    perNumber: { meta, waha, unknown: Math.min(meta, waha) },
    tickBudgetMs: clamp(readInt(env, "DISPARADOR_TICK_BUDGET_MS") ?? 35_000, 5_000, 50_000),
    adaptiveBackoff: !(backoffFlag === "0" || backoffFlag === "false" || backoffFlag === "off"),
    maxEventLoopLagMs: clamp(readInt(env, "DISPARADOR_MAX_EVENT_LOOP_LAG_MS") ?? 200, 20, 10_000),
    maxRssMb: clamp(readInt(env, "DISPARADOR_MAX_RSS_MB") ?? 1024, 128, 65_536),
    cooldownSeconds: clamp(readInt(env, "DISPARADOR_BACKOFF_COOLDOWN_SECONDS") ?? 300, 0, 3_600),
  };
}

/**
 * Concorrência inicial de um número no tick.
 * - linha em dispatch_channel_limits → max_in_flight dela;
 * - senão, o padrão do provedor (variáveis de ambiente);
 * - em cooldown (backoff recente) → metade, mínimo 1.
 */
export function resolveChannelConcurrency(params: {
  provider: DispatchProvider | null;
  rowMaxInFlight: number | null | undefined;
  inCooldown: boolean;
  config: ThroughputConfig;
}): number {
  const base =
    params.rowMaxInFlight !== null && params.rowMaxInFlight !== undefined && params.rowMaxInFlight > 0
      ? clamp(params.rowMaxInFlight, 1, MAX_PER_NUMBER_CONCURRENCY)
      : params.config.perNumber[params.provider ?? "unknown"];
  return params.inCooldown ? Math.max(1, Math.floor(base / 2)) : base;
}

// ------------------------------------------------------------
// Cooldown por número. O banco (wacrm.dispatch_channel_cooldowns,
// migration 164) vale entre processos/restarts; este Map é só um atalho
// do mesmo processo para quando a tabela ainda não existe. Não é worker
// em memória: nada roda em segundo plano, só é consultado no tick.
// ------------------------------------------------------------
const memoryCooldowns = new Map<string, number>();

export function rememberCooldown(sessionId: string, untilMs: number): void {
  memoryCooldowns.set(sessionId, Math.max(untilMs, memoryCooldowns.get(sessionId) ?? 0));
}

export function isInCooldown(
  sessionId: string,
  nowMs: number,
  dbCooldownUntil?: string | null
): boolean {
  const memory = memoryCooldowns.get(sessionId);
  if (memory !== undefined && memory <= nowMs) memoryCooldowns.delete(sessionId);
  if (memory !== undefined && memory > nowMs) return true;
  if (!dbCooldownUntil) return false;
  const until = Date.parse(dbCooldownUntil);
  return Number.isFinite(until) && until > nowMs;
}

/** Só para testes. */
export function clearMemoryCooldowns(): void {
  memoryCooldowns.clear();
}
