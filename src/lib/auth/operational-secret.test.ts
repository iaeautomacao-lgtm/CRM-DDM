import { describe, expect, it } from 'vitest';
import { matchesOperationalSecret } from './operational-secret';

describe('operational secrets', () => {
  it('rejects unconfigured, missing, empty and incorrect credentials', () => {
    expect(matchesOperationalSecret(undefined, null)).toBe(false);
    expect(matchesOperationalSecret('', '')).toBe(false);
    expect(matchesOperationalSecret('secret', null)).toBe(false);
    expect(matchesOperationalSecret('secret', 'other')).toBe(false);
    expect(matchesOperationalSecret('secret', 'longer-secret')).toBe(false);
  });
  it('accepts only the configured secret', () => {
    expect(matchesOperationalSecret('secret', 'secret')).toBe(true);
  });
});
