import { describe, expect, it } from 'vitest';
import { safeReturnPath } from './return-path';

describe('safe return paths', () => {
  it('preserves local task URLs and recovery destinations', () => {
    expect(safeReturnPath('/contacts/123?tab=history')).toBe(
      '/contacts/123?tab=history'
    );
    expect(safeReturnPath('/reset-password')).toBe('/reset-password');
  });
  it('rejects external destinations, encoded separators and login loops', () => {
    for (const input of [
      'https://evil.test',
      '//evil.test',
      '/\\evil.test',
      '/%2F%2Fevil.test',
      '/login',
      '/api/delete',
      '/auth/login',
      '/%',
    ]) {
      expect(safeReturnPath(input)).toBe('/dashboard');
    }
  });
});
