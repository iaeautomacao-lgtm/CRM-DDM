// Portão de chamadas à OpenAI (B12 do plano de capacidade).
//
// Na onda de respostas de uma campanha grande chegam vários clientes por
// segundo e cada um dispara 1–5 completions. Sem limite, o processo abre
// dezenas de conexões ao mesmo tempo, estoura o TPM/RPM da conta (429) e o
// vigia de IA travada (180 s) devolvia as conversas em massa para humanos.
//
// Aqui: (1) semáforo por processo (AI_LLM_MAX_CONCURRENCY, padrão 20);
// (2) espera curta + nova tentativa limitada em 429, respeitando Retry-After.
//
// Segurança do retry: um 429 significa que a OpenAI REJEITOU a requisição
// (nada foi gerado nem executado), então repetir só a chamada HTTP não
// duplica efeito externo — as tools só rodam depois de uma resposta 200. O
// contrato de retry da tentativa inteira (release_ai_reply, só antes de efeito
// externo) continua em responder.ts e não muda.
//
// Sem estado persistente: o semáforo é em memória do processo (Passenger
// pode reiniciar a qualquer momento; nada depende dele para correção).

function envInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Chamadas simultâneas à OpenAI por processo. */
export function llmMaxConcurrency(): number {
  return envInt("AI_LLM_MAX_CONCURRENCY", 20);
}
/** Quanto uma chamada espera por vaga antes de desistir (bem abaixo dos 180 s do vigia). */
export function llmQueueMaxWaitMs(): number {
  return envInt("AI_LLM_QUEUE_MAX_WAIT_MS", 60_000);
}
/** Nº máximo de novas tentativas após 429. */
export function llmRateLimitRetries(): number {
  return envInt("AI_LLM_429_MAX_RETRIES", 2);
}
/** Teto da espera por tentativa (mesmo que o Retry-After peça mais). */
export function llmRateLimitMaxWaitMs(): number {
  return envInt("AI_LLM_429_MAX_WAIT_MS", 8_000);
}

/** Erro lançado quando a espera por vaga estoura — falha antes de qualquer chamada. */
export class LlmQueueTimeoutError extends Error {
  constructor(waitedMs: number) {
    super(`llm_queue_timeout: sem vaga para chamar a IA após ${Math.round(waitedMs / 1000)}s`);
    this.name = "LlmQueueTimeoutError";
  }
}

interface Waiter {
  resolve: () => void;
  cancelled: boolean;
}

let inFlight = 0;
const waiters: Waiter[] = [];

/** Só para testes/telemetria. */
export function llmGateStats(): { inFlight: number; waiting: number } {
  return { inFlight, waiting: waiters.length };
}

/** Zera o estado (testes). */
export function resetLlmGate(): void {
  inFlight = 0;
  waiters.length = 0;
}

const HEARTBEAT_TICK_MS = 10_000;

/**
 * Reserva uma vaga. Enquanto espera, chama `onWaiting` a cada 10 s — o
 * responder usa isso para renovar o heartbeat "IA trabalhando", de modo que
 * fila de vaga NÃO conta como travada para o vigia.
 */
export async function acquireLlmSlot(opts: {
  onWaiting?: () => void | Promise<void>;
  maxWaitMs?: number;
} = {}): Promise<() => void> {
  const release = () => {
    inFlight -= 1;
    while (waiters.length > 0) {
      const next = waiters.shift()!;
      if (next.cancelled) continue;
      inFlight += 1;
      next.resolve();
      return;
    }
  };

  if (inFlight < llmMaxConcurrency()) {
    inFlight += 1;
    return release;
  }

  const maxWaitMs = opts.maxWaitMs ?? llmQueueMaxWaitMs();
  const startedAt = Date.now();
  const waiter: Waiter = { resolve: () => {}, cancelled: false };
  const granted = new Promise<void>((resolve) => {
    waiter.resolve = resolve;
  });
  waiters.push(waiter);

  while (true) {
    const remaining = maxWaitMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      waiter.cancelled = true;
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) waiters.splice(idx, 1);
      throw new LlmQueueTimeoutError(Date.now() - startedAt);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = new Promise<"tick">((resolve) => {
      timer = setTimeout(() => resolve("tick"), Math.min(HEARTBEAT_TICK_MS, remaining));
    });
    const winner = await Promise.race([granted.then(() => "granted" as const), tick]);
    if (timer) clearTimeout(timer);
    if (winner === "granted") return release;
    try {
      await opts.onWaiting?.();
    } catch {
      // heartbeat é best-effort
    }
  }
}

/** Interpreta Retry-After (segundos ou data HTTP) em ms; null se ausente/inválido. */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return null;
}

/** Espera antes da nova tentativa: Retry-After (se houver) ou backoff 1 s, 2 s…, com teto e jitter. */
export function rateLimitDelayMs(
  attempt: number,
  retryAfterHeader: string | null | undefined,
  random: () => number = Math.random,
): number {
  const cap = llmRateLimitMaxWaitMs();
  const fromHeader = parseRetryAfterMs(retryAfterHeader);
  const base = fromHeader ?? 1000 * 2 ** (attempt - 1);
  const jitter = Math.round(random() * 250);
  return Math.min(cap, base + jitter);
}

export interface GatedFetchOptions {
  /** Chamado enquanto espera vaga ou o fim de um 429 (renova o heartbeat). */
  onWaiting?: () => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Executa `doFetch` (uma chamada HTTP à OpenAI) sob o semáforo. Em 429 libera
 * a vaga, espera e tenta de novo (até AI_LLM_429_MAX_RETRIES). Qualquer
 * outra resposta — inclusive o último 429 — é devolvida ao chamador, que
 * trata o erro como antes.
 */
export async function gatedFetch(
  doFetch: () => Promise<Response>,
  opts: GatedFetchOptions = {},
): Promise<Response> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxRetries = llmRateLimitRetries();
  for (let attempt = 1; ; attempt++) {
    const release = await acquireLlmSlot({ onWaiting: opts.onWaiting });
    let response: Response;
    try {
      response = await doFetch();
    } finally {
      release();
    }
    if (response.status !== 429 || attempt > maxRetries) return response;
    const delay = rateLimitDelayMs(attempt, response.headers.get("retry-after"));
    console.warn(`[AI Agent] OpenAI 429 — nova tentativa ${attempt}/${maxRetries} em ${delay}ms`);
    // Descarta o corpo para liberar a conexão.
    await response.text().catch(() => "");
    await sleep(delay);
    try {
      await opts.onWaiting?.();
    } catch {
      // best-effort
    }
  }
}
