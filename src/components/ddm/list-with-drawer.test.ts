import { describe, expect, it } from 'vitest';

import { rowDelay } from './list-with-drawer';

describe('rowDelay', () => {
  it('escalona 30 ms por linha, com teto em 12 linhas', () => {
    expect(rowDelay(undefined)).toBeUndefined();
    expect(rowDelay(0)).toBe(0);
    expect(rowDelay(3)).toBe(90);
    expect(rowDelay(50)).toBe(360);
  });
});
