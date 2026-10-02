import { describe, expect, it } from 'vitest';
import { processWithConcurrency } from './concurrency';

describe('bounded queue processing', () => {
  it('processes every item once and caps concurrent work', async () => {
    let active = 0;
    let peak = 0;
    const processed: number[] = [];
    await processWithConcurrency(
      Array.from({ length: 100 }, (_, i) => i),
      4,
      async (item) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        processed.push(item);
        active--;
      }
    );
    expect(peak).toBe(4);
    expect(new Set(processed).size).toBe(100);
    expect(processed).toHaveLength(100);
  });
  it('does not silently discard work with an invalid limit', async () => {
    await expect(
      processWithConcurrency([1], 0, async () => {})
    ).rejects.toThrow('Invalid concurrency');
  });
});
