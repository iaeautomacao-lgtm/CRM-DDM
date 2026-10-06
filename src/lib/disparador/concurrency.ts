/**
 * Processa `items` com no máximo `concurrency` tarefas simultâneas.
 *
 * Implementado como um pool de "workers" que consomem um índice
 * compartilhado, em vez de criar uma Promise por item: o número de
 * operações em andamento (e de chamadas simultâneas ao provedor) fica
 * limitado independentemente do tamanho do lote.
 *
 * `nextIndex++` é seguro sem lock porque o JS é single-thread: o
 * incremento acontece de forma síncrona antes do próximo `await`.
 *
 * Erros lançados por `process` rejeitam o Promise.all — quem chama deve
 * capturar dentro de `process` se quiser continuar o lote (o cron faz isso).
 */
export async function processWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  process: (item: T) => Promise<void>
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('Invalid concurrency');
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++];
        await process(item);
      }
    })
  );
}


export const DEFAULT_DISPATCH_PROCESS_CONCURRENCY = 4;
export const MAX_DISPATCH_PROCESS_CONCURRENCY = 50;

/**
 * Resolve o limite do pool do cron a partir do ambiente.
 *
 * O banco continua sendo a barreira final por canal via
 * dispatch_channel_limits.max_in_flight. Aqui limitamos apenas quantas
 * operações o processo tenta manter em andamento ao mesmo tempo.
 *
 * Valor inválido não derruba o cron: volta ao default seguro.
 */
export function resolveDispatchProcessConcurrency(
  raw = process.env.DISPATCH_PROCESS_CONCURRENCY,
): number {
  if (raw == null || raw.trim() === "") return DEFAULT_DISPATCH_PROCESS_CONCURRENCY;
  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_DISPATCH_PROCESS_CONCURRENCY
  ) {
    return DEFAULT_DISPATCH_PROCESS_CONCURRENCY;
  }
  return parsed;
}
