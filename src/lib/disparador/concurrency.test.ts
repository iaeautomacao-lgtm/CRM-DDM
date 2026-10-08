import { describe, expect, it, vi } from 'vitest';
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

  it('número fora da faixa faz clamp em [1, 150] com aviso — nunca cai para 4 (REVISAO F15)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveDispatchProcessConcurrency('151')).toBe(150);
    expect(resolveDispatchProcessConcurrency('999')).toBe(150);
    expect(resolveDispatchProcessConcurrency('64')).toBe(64);
    expect(resolveDispatchProcessConcurrency('150')).toBe(150);
    expect(resolveDispatchProcessConcurrency('0')).toBe(1);
    expect(resolveDispatchProcessConcurrency('-3')).toBe(1);
    expect(resolveDispatchProcessConcurrency('12.5')).toBe(12);
    expect(resolveDispatchProcessConcurrency(' 48 ')).toBe(48);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('texto que não é número usa o padrão seguro, com aviso', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveDispatchProcessConcurrency('abc')).toBe(DEFAULT_DISPATCH_PROCESS_CONCURRENCY);
    expect(resolveDispatchProcessConcurrency('Infinity')).toBe(DEFAULT_DISPATCH_PROCESS_CONCURRENCY);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
