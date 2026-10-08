/**
 * In-memory per-key rate limiter.
 *
 * Fixed-window counter (not token bucket): every identifier gets a
 * fresh N-request budget each window. Simple, allocation-light, and
 * fine for a single-instance VPS — which is how forkers of this
 * template will usually deploy.
 *
 * Trade-off: a single Node process holds the Map, so horizontal scale
 * (multiple regions, multiple Hostinger nodes, Vercel serverless fan-
 * out) silently defeats the limit. If you scale beyond one instance,
 * swap the `check` implementation for Redis / Upstash / Cloudflare
 * Durable Objects keeping the same return shape. The call sites won't
 * change.
 *
 * Memory: entries are ~50 bytes each. With LIGHT_SWEEP below, expired
 * keys get cleared opportunistically on every ~1 000th call, so a
 * healthy instance stays in the low-MB range even with thousands of
 * distinct users. No background timer — works in serverless edge
 * runtimes that don't keep timers alive across requests.
 */

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

export interface RateLimitOptions {
  /** Max requests allowed in `windowMs`. */
  limit: number;
  /** Window size, milliseconds. */
  windowMs: number;
}

export interface RateLimitResult {
  success: boolean;
  /** Requests still allowed in the current window. */
  remaining: number;
  /** Unix ms when the bucket refills. */
  reset: number;
  limit: number;
}

interface Entry {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Entry>();

// Opportunistic cleanup. Running a sweep on every call would be
// quadratic; running it 1-in-N lets the Map self-drain without a
// background timer.
const LIGHT_SWEEP_EVERY = 1000;
let callsSinceSweep = 0;

function sweepExpired(now: number) {
  for (const [k, v] of buckets) {
    if (v.resetAt <= now) buckets.delete(k);
  }
}

/** Resultado de um acerto no contador COMPARTILHADO (RPC wacrm.rate_limit_hit, migration 221). */
export interface SharedHit {
  success: boolean;
  remaining: number;
  /** Unix ms em que a janela do banco vence. */
  resetAt: number;
}

/** Backend compartilhado: devolve null se indisponível (o chamador cai no Map). */
export type SharedBackend = (key: string, limit: number, windowSeconds: number) => Promise<SharedHit | null>;

const SHARED_TIMEOUT_MS = 1_000;
const SHARED_DOWN_MS = 30_000; // erro/timeout: não insiste por 30 s
const SHARED_MISSING_MS = 60_000; // 221 ainda não aplicada: confere de novo em 1 min
let sharedDownUntil = 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- cliente com schema wacrm, sem tipos gerados
let sharedClient: any = null;
let sharedOverride: SharedBackend | null | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getSharedClient(): any {
  if (sharedClient) return sharedClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null; // testes/ambiente sem banco: só o Map
  sharedClient = createClient(url, key, {
    db: { schema: 'wacrm' },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return sharedClient;
}

/** Backend padrão: 1 RPC por chamada, com timeout curto e disjuntor. Nunca lança. */
const defaultSharedBackend: SharedBackend = async (key, limit, windowSeconds) => {
  const now = Date.now();
  if (now < sharedDownUntil) return null;
  const client = getSharedClient();
  if (!client) return null;
  try {
    const call = client.rpc('rate_limit_hit', { p_key: key, p_limit: limit, p_window_s: windowSeconds });
    const result = await Promise.race([
      call,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SHARED_TIMEOUT_MS)),
    ]);
    if (result === null) {
      sharedDownUntil = Date.now() + SHARED_DOWN_MS;
      return null;
    }
    const { data, error } = result as { data: unknown; error: { code?: string; message?: string } | null };
    if (error) {
      const missing = error.code === 'PGRST202' || error.code === '42883' || /could not find the function|does not exist/i.test(error.message ?? '');
      sharedDownUntil = Date.now() + (missing ? SHARED_MISSING_MS : SHARED_DOWN_MS);
      return null;
    }
    const row = (Array.isArray(data) ? data[0] : data) as { success?: boolean; remaining?: number; reset_at?: string } | null | undefined;
    if (!row || typeof row.success !== 'boolean' || !row.reset_at) return null;
    return { success: row.success, remaining: Math.max(0, Number(row.remaining ?? 0)), resetAt: new Date(row.reset_at).getTime() };
  } catch {
    sharedDownUntil = Date.now() + SHARED_DOWN_MS;
    return null;
  }
};

/** Só para testes: troca o backend compartilhado (null = só Map; undefined = o padrão). */
export function __setSharedBackendForTests(backend: SharedBackend | null | undefined): void {
  sharedOverride = backend;
  sharedDownUntil = 0;
}

/**
 * Limite com DOIS níveis (PRD 14, 14.9): o Map do processo barra rajada sem custo; o contador compartilhado no Postgres
 * (migration 221) vale entre processos e sobrevive a restart. Se o compartilhado falhar, estourar o tempo (1 s) ou não
 * existir, vale só o Map — o limitador nunca derruba a rota. 1 RPC por chamada permitida pelo Map: NÃO use em caminho
 * quente (tick/cron/webhook de status); lá use checkRateLimitLocal.
 */
export async function checkRateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  const local = checkRateLimitLocal(key, options);
  if (!local.success) return local;

  const backend = sharedOverride === undefined ? defaultSharedBackend : sharedOverride;
  if (!backend) return local;
  let shared: SharedHit | null = null;
  try {
    shared = await backend(key, options.limit, Math.max(1, Math.ceil(options.windowMs / 1000)));
  } catch {
    shared = null;
  }
  if (!shared) return local;

  if (!shared.success) {
    // Outras instâncias já gastaram o orçamento: satura o Map até a janela do banco vencer (não repete a RPC em enxurrada).
    const entry = buckets.get(key);
    if (entry) {
      entry.count = options.limit;
      entry.resetAt = shared.resetAt;
    }
  }
  return { success: shared.success, remaining: shared.remaining, reset: shared.resetAt, limit: options.limit };
}

/** O Map já está saturado para esta chave (limite atingido na janela corrente)? Não conta, não faz rede. */
export function isRateLimitedLocal(key: string, limit: number): boolean {
  const entry = buckets.get(key);
  return !!entry && entry.resetAt > Date.now() && entry.count >= limit;
}

/** Só o Map do processo (síncrono, sem rede): para caminhos quentes ou quando a RPC não faz sentido. */
export function checkRateLimitLocal(
  key: string,
  { limit, windowMs }: RateLimitOptions,
): RateLimitResult {
  const now = Date.now();

  callsSinceSweep += 1;
  if (callsSinceSweep >= LIGHT_SWEEP_EVERY) {
    callsSinceSweep = 0;
    sweepExpired(now);
  }

  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, remaining: limit - 1, reset: now + windowMs, limit };
  }

  if (entry.count >= limit) {
    return { success: false, remaining: 0, reset: entry.resetAt, limit };
  }

  entry.count += 1;
  return {
    success: true,
    remaining: limit - entry.count,
    reset: entry.resetAt,
    limit,
  };
}

/**
 * Standard 429 response with the headers clients expect (RFC 6585 +
 * draft-ietf-httpapi-ratelimit-headers). Callers just `return` this.
 */
export function rateLimitResponse(result: RateLimitResult): NextResponse {
  const retryAfterSec = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return NextResponse.json(
    {
      error: 'Rate limit exceeded',
      retry_after_seconds: retryAfterSec,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
      },
    },
  );
}

/** Preconfigured budgets, tweak here not at call sites. */
export const RATE_LIMITS = {
  /** Individual message send. 60/min per user = one per second
   *  sustained, comfortable for a live human typing. */
  send: { limit: 60, windowMs: 60_000 },
  /** Reaction add/swap/remove. More permissive than send — users
   *  fidget with reactions and a single "swap" is actually two calls
   *  (remove + add) under the hood. */
  react: { limit: 120, windowMs: 60_000 },
  /** Invitation peek (public, per-IP). 30/min lets a forwarded link
   *  retry a handful of times under flaky connectivity without
   *  enabling brute-force token enumeration. With 256-bit tokens the
   *  enumeration risk is theoretical; this is belt-and-braces. */
  invitationPeek: { limit: 30, windowMs: 60_000 },
  /** Invitation redeem (authed, per-IP+user). Tighter than peek —
   *  successful redemption mutates two profiles and an invite row, so
   *  the abuse surface is "spam join attempts." */
  invitationRedeem: { limit: 10, windowMs: 60_000 },
  /** Invitation redeem BY SHORT CODE (authed, per-user). Codes are
   *  8 chars from a 31-symbol alphabet (~40 bits — see
   *  generateInviteCode in lib/auth/invitations.ts), far below a link
   *  token's 256 bits, so guessing is a real concern in a way it isn't
   *  for links. Keyed by the caller's user id rather than IP: redeeming
   *  requires a signed-in session, and spinning up a fresh account per
   *  guess is real friction an IP-hop doesn't have to pay. At 5 tries
   *  per 5 minutes, even a bot left running indefinitely only ever
   *  covers a vanishing fraction of the ~8.5×10^11 possible codes. */
  invitationRedeemByCode: { limit: 5, windowMs: 5 * 60_000 },
  /** Admin-only account / member-management actions: create/revoke
   *  invitation, rename account, change member role, remove member,
   *  transfer ownership. 30/min per user is comfortably above any
   *  realistic legitimate use (the Members tab is a clicks-only UI)
   *  while still bounding accidental abuse from a script run in a
   *  loop or a compromised admin session spamming role flips. */
  adminAction: { limit: 30, windowMs: 60_000 },
  /** Public REST API (`/api/v1/*`), keyed per API key. 120/min ≈ 2
   *  req/s sustained — comfortable for a polling integration or an
   *  automation firing on inbound events, while bounding a runaway
   *  script. Like every bucket here it's per-process; a multi-
   *  instance deploy needs the Redis swap described at the top of
   *  this file (the per-key call sites don't change). */
  publicApi: { limit: 120, windowMs: 60_000 },
  /** GET de verificação do webhook Meta (público, por IP). A Meta só chama ao
   *  (re)assinar; 30/min por IP cobre tentativas legítimas e barra quem testa
   *  verify_token em laço (PRD 14, SG-9). */
  webhookVerify: { limit: 30, windowMs: 60_000 },
  /** Telemetria e feedback do app (por usuário) — AP-08. */
  telemetry: { limit: 60, windowMs: 60_000 },
  feedback: { limit: 60, windowMs: 60_000 },
  /** Tentativas com chave de API inválida, por IP — barra o flood ANTES de consultar o banco (AP-09). */
  apiKeyFailures: { limit: 30, windowMs: 60_000 },
  /** Webchat público (por IP + token) — AP-19: leitura/poll/mídia e abertura/upload. */
  webchatRead: { limit: 120, windowMs: 60_000 },
  webchatWrite: { limit: 30, windowMs: 60_000 },
} as const;

/** Test-only helper. Clears the in-memory state so unit tests don't
 *  leak buckets across files. Not wired up in production code. */
export function __resetRateLimitForTests() {
  buckets.clear();
  callsSinceSweep = 0;
  sharedOverride = undefined;
  sharedDownUntil = 0;
  sharedClient = null;
}
