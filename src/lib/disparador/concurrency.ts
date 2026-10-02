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
