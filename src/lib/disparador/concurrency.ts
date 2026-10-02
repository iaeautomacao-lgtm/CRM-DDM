/** Bounds outstanding work without allocating one Promise for every queue item. */
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
