// Insert da fila da campanha em blocos paralelos (B9).
//
// Antes: blocos de 500, um de cada vez (100k = 200 idas ao banco em série).
// Agora: blocos de 1.000, até 3 em voo. `onBlockDone` roda a cada bloco
// gravado (a preparação usa para renovar campaigns.updated_at e a
// recuperação de 30 min não cortar uma preparação viva). Qualquer erro
// aborta: nenhum bloco novo começa e o erro sobe depois de os que já estavam
// em voo terminarem (a limpeza da fila é do chamador).

export const QUEUE_INSERT_BLOCK = 1000;
export const QUEUE_INSERT_CONCURRENCY = 3;

export async function insertInBlocks<Row>(
  rows: readonly Row[],
  insertBlock: (block: Row[]) => PromiseLike<{ error: { message: string } | null }>,
  options: {
    blockSize?: number;
    concurrency?: number;
    onBlockDone?: (written: number) => void | Promise<void>;
  } = {},
): Promise<void> {
  const blockSize = Math.max(1, options.blockSize ?? QUEUE_INSERT_BLOCK);
  const concurrency = Math.max(1, options.concurrency ?? QUEUE_INSERT_CONCURRENCY);
  let next = 0;
  let written = 0;
  let failure: Error | null = null;

  const worker = async () => {
    while (!failure) {
      const start = next;
      if (start >= rows.length) return;
      next += blockSize;
      const block = rows.slice(start, start + blockSize);
      try {
        const { error } = await insertBlock(block as Row[]);
        if (error) throw new Error(error.message);
        written += block.length;
        await options.onBlockDone?.(written);
      } catch (err) {
        failure ??= err instanceof Error ? err : new Error(String(err));
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.ceil(rows.length / blockSize)) }, worker));
  if (failure) throw failure;
}
