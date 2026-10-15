// Latência das chamadas de claim do disparador (por item e em lote), para o `cron_tick` mostrar o p95 do claim (critério da bancada: < 10 ms).
// Coletor do PROCESSO: o lock global garante um tick por vez; o TickTelemetry zera no início e drena ao montar o payload. Só mede; não decide nada.

const MAX_SAMPLES = 50_000;
let samples: number[] = [];

export function recordClaimLatency(ms: number): void {
  if (Number.isFinite(ms) && ms >= 0 && samples.length < MAX_SAMPLES) samples.push(ms);
}

/** Devolve as amostras acumuladas e zera o coletor. */
export function drainClaimLatencies(): number[] {
  const out = samples;
  samples = [];
  return out;
}

/** Mede a chamada `fn` (promessa ou thenable do supabase-js) e registra a duração, com sucesso ou falha. */
export async function timedClaim<T>(fn: () => PromiseLike<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    recordClaimLatency(performance.now() - start);
  }
}
