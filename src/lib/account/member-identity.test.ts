import { describe, expect, it } from 'vitest';
import { validateMemberIdentity } from './member-identity';

describe('validateMemberIdentity', () => {
  it('normalizes the member name and email', () => {
    expect(validateMemberIdentity({
      full_name: '  Maria   da Silva  ',
      email: '  MARIA.SILVA@EXAMPLE.COM  ',
    })).toEqual({
      valid: true,
      data: { full_name: 'Maria da Silva', email: 'maria.silva@example.com' },
    });
  });

  it.each([
    null, {}, [], { full_name: 'A', email: 'a@b.com' },
    { full_name: 'Pessoa Válida', email: 'not-an-email' },
    { full_name: 'Pessoa Válida', email: 'a@b' },
    { full_name: 'Pessoa Válida', email: 123 },
    { full_name: 'a'.repeat(121), email: 'valid@example.com' },
  ])('rejects invalid payloads', input => {
    expect(validateMemberIdentity(input).valid).toBe(false);
  });
});
