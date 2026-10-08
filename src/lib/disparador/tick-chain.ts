// Tick ENCADEADO do disparador (P1-3a, auditoria F1/§1.3 item 1).
//
// Problema: o cron externo dispara 1×/min e o tick (orçamento 35 s) deixa ~40% do relógio ocioso; a 80 envios/s por número
// isso vira o teto. Solução stateless: ao terminar o tick (já com o lock liberado), se ele processou trabalho, ele mesmo
// dispara um POST ao próprio /api/disparador/cron (mesmo segredo). Cada hop é uma requisição curta (o hop encadeado responde 202 na hora e
// roda o tick em `after()`); o cron externo de 60 s continua como RESSUSCITADOR (se a cadeia morrer num restart, ele recomeça).
//
// Proteções contra laço:
//   * só encadeia se o tick PROCESSOU algo (status "processed"); tick ocioso (nada vencido) encerra a cadeia;
//   * máximo de hops por minuto (DISPARADOR_TICK_CHAIN_MAX_PER_MIN, padrão 6) e máximo absoluto por cadeia (padrão 90) — depois disso
//     o cron externo reinicia a cadeia;
//   * o lock `disparador_cron` garante que nunca rodam dois ticks ao mesmo tempo (hop que chega com o lock tomado devolve already_running).
// Manutenção pesada (reconcile de recibos, watchdog, preparo de campanhas, outbox, limpeza) só a cada N hops (DISPARADOR_TICK_CHAIN_MAINTENANCE_EVERY,
// padrão 5); os passos com lock de TTL (retry, 131026, métricas, moves) já se limitam sozinhos.
//
// REQUISITO DE INFRA: o hop do cron EXTERNO ainda é uma requisição síncrona de até ~55 s (orçamento 50 s). O proxy do EasyPanel/Passenger precisa de
// timeout ≥ 60 s para a rota /api/disparador/cron. Os hops encadeados NÃO dependem disso (respondem 202 imediatamente).
//
// Desligado por padrão: DISPARADOR_TICK_CHAIN=1 liga. Funções puras (recebem env/headers/fetch) — testáveis.

type Env = Record<string, string | undefined>;

export const CHAIN_HOP_HEADER = 'x-cron-hop';
export const CHAIN_START_HEADER = 'x-cron-chain-start';

export interface TickChainConfig {
  enabled: boolean;
  maxHopsPerMinute: number;
  maxHops: number;
  maintenanceEvery: number;
  /** Origem usada para chamar o próprio cron (DISPARADOR_CHAIN_URL ou NEXT_PUBLIC_APP_URL). null = não dá para encadear. */
  baseUrl: string | null;
}

export function isTickChainEnabled(env: Env = process.env): boolean {
  const raw = (env.DISPARADOR_TICK_CHAIN ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

const intIn = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function originOf(raw: string | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function resolveTickChainConfig(env: Env = process.env): TickChainConfig {
  return {
    enabled: isTickChainEnabled(env),
    maxHopsPerMinute: intIn(env.DISPARADOR_TICK_CHAIN_MAX_PER_MIN, 6, 1, 60),
    maxHops: intIn(env.DISPARADOR_TICK_CHAIN_MAX_HOPS, 90, 1, 1000),
    maintenanceEvery: intIn(env.DISPARADOR_TICK_CHAIN_MAINTENANCE_EVERY, 5, 1, 100),
    baseUrl: originOf(env.DISPARADOR_CHAIN_URL) ?? originOf(env.NEXT_PUBLIC_APP_URL),
  };
}

export interface ChainContext {
  /** 0 = tick do cron externo (início de cadeia); n = n-ésimo hop encadeado. */
  hop: number;
  /** Instante (ms) do início da cadeia. */
  startedAtMs: number;
  /** true quando a requisição veio de um hop encadeado (header presente e válido). */
  chained: boolean;
}

const MAX_CHAIN_AGE_MS = 60 * 60 * 1000;

/** Lê (e saneia) os headers de hop. Valores ausentes/inválidos = início de cadeia (hop 0). */
export function readChainContext(headers: Pick<Headers, 'get'>, nowMs: number = Date.now()): ChainContext {
  const hopRaw = headers.get(CHAIN_HOP_HEADER);
  const startRaw = headers.get(CHAIN_START_HEADER);
  const hop = hopRaw !== null && /^\d{1,4}$/.test(hopRaw.trim()) ? Number.parseInt(hopRaw, 10) : 0;
  const start = startRaw !== null && /^\d{10,16}$/.test(startRaw.trim()) ? Number.parseInt(startRaw, 10) : NaN;
  if (hop <= 0 || !Number.isFinite(start) || start > nowMs + 5_000 || nowMs - start > MAX_CHAIN_AGE_MS) {
    return { hop: 0, startedAtMs: nowMs, chained: false };
  }
  return { hop, startedAtMs: start, chained: true };
}

/** Manutenção pesada neste hop? Sempre no hop 0 (cron externo) e a cada N hops. */
export function isMaintenanceHop(hop: number, every: number): boolean {
  return hop % Math.max(1, every) === 0;
}

export interface ChainDecision {
  chain: boolean;
  reason: 'disabled' | 'no_base_url' | 'not_processed' | 'max_hops' | 'rate_limited' | 'ok';
}

/** Decide se este tick deve disparar o próximo hop. `tickStatus` = "processed" quando houve envio/trabalho. */
export function shouldChainNext(params: {
  config: TickChainConfig;
  ctx: ChainContext;
  tickStatus: string;
  nowMs?: number;
}): ChainDecision {
  const { config, ctx } = params;
  const nowMs = params.nowMs ?? Date.now();
  if (!config.enabled) return { chain: false, reason: 'disabled' };
  if (!config.baseUrl) return { chain: false, reason: 'no_base_url' };
  // Sem item vencido processado (idle/erro/migration_required…): encerra a cadeia.
  if (params.tickStatus !== 'processed') return { chain: false, reason: 'not_processed' };
  const nextHop = ctx.hop + 1;
  if (nextHop > config.maxHops) return { chain: false, reason: 'max_hops' };
  // hops por minuto desde o início da cadeia (mínimo de 1 min de janela, para a rajada inicial não ser punida).
  const minutes = Math.max(1, (nowMs - ctx.startedAtMs) / 60_000);
  if (nextHop / minutes > config.maxHopsPerMinute) return { chain: false, reason: 'rate_limited' };
  return { chain: true, reason: 'ok' };
}

/**
 * Dispara o próximo hop (POST ao próprio cron). Nunca lança: falha só encerra a cadeia (o cron externo ressuscita).
 * O hop encadeado responde 202 na hora; esperamos só essa resposta (timeout curto).
 */
export async function fireNextHop(params: {
  config: TickChainConfig;
  ctx: ChainContext;
  secret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<boolean> {
  const { config, ctx } = params;
  if (!config.baseUrl) return false;
  const doFetch = params.fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${config.baseUrl}/api/disparador/cron`, {
      method: 'POST',
      headers: {
        'x-cron-secret': params.secret,
        [CHAIN_HOP_HEADER]: String(ctx.hop + 1),
        [CHAIN_START_HEADER]: String(ctx.startedAtMs),
      },
      signal: AbortSignal.timeout(params.timeoutMs ?? 10_000),
    });
    return res.status === 202 || res.ok;
  } catch (error) {
    console.warn('[Cron] Hop encadeado não disparou (o cron externo retoma):', error instanceof Error ? error.message : error);
    return false;
  }
}
