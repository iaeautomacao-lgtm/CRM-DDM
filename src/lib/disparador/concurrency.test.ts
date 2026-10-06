import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPATCH_PROCESS_CONCURRENCY,
  processWithConcurrency,
  resolveDispatchProcessConcurrency,
} from './concurrency';

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


describe('dispatch process concurrency config', () => {
  it('defaults to 4 when unset', () => {
    expect(resolveDispatchProcessConcurrency(undefined)).toBe(4);
    expect(DEFAULT_DISPATCH_PROCESS_CONCURRENCY).toBe(4);
  });

  it('accepts an explicit safe integer', () => {
    expect(resolveDispatchProcessConcurrency('10')).toBe(10);
  });

  it('falls back to 8 for invalid or unsafe values', () => {
    expect(resolveDispatchProcessConcurrency('0')).toBe(4);
    expect(resolveDispatchProcessConcurrency('51')).toBe(4);
    expect(resolveDispatchProcessConcurrency('abc')).toBe(4);
    expect(resolveDispatchProcessConcurrency('2.5')).toBe(4);
  });
});
