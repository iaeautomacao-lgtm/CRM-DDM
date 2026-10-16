import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  admin: vi.fn(),
  getUserById: vi.fn(),
  updateUserById: vi.fn(),
  writeLog: vi.fn(),
  target: {
    user_id: '22222222-2222-4222-8222-222222222222',
    account_role: 'agent',
    full_name: 'Nome Anterior',
    email: 'old@example.com',
  } as { user_id: string; account_role: string; full_name: string; email: string } | null,
  updateError: null as null | { code: string },
  updateThrows: false,
  updateValues: [] as Array<Record<string, unknown>>,
  filters: [] as Array<[string, unknown]>,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: () => Response.json({ error: 'Erro interno' }, { status: 500 }),
}));
vi.mock('@/lib/account/admin-client', () => ({ supabaseAdmin: mocks.admin }));
vi.mock('@/lib/logger', () => ({ writeLog: mocks.writeLog }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'Limite' }, { status: 429 }),
  RATE_LIMITS: { adminAction: { limit: 100, windowMs: 60000 } },
}));

import { PATCH } from './route';

const userId = '22222222-2222-4222-8222-222222222222';
const currentId = '11111111-1111-4111-8111-111111111111';
const accountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const params = { params: Promise.resolve({ userId }) };
const request = (body: unknown, origin?: string) => new Request(
  'https://omnicrm.grupoddm.ia.br/api/account/members/'+userId+'/identity',
  {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  },
);
const valid = { full_name: 'Nome Atualizado', email: 'new@example.com' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.target = {
    user_id: userId, account_role: 'agent',
    full_name: 'Nome Anterior', email: 'old@example.com',
  };
  mocks.updateError = null;
  mocks.updateThrows = false;
  mocks.updateValues.length = 0;
  mocks.filters.length = 0;
  mocks.requireRole.mockResolvedValue({
    userId: currentId, accountId, role: 'admin',
  });
  mocks.getUserById.mockResolvedValue({
    data: { user: { email: 'old@example.com' } }, error: null,
  });
  mocks.updateUserById.mockResolvedValue({ data: { user: {} }, error: null });
  mocks.writeLog.mockResolvedValue(undefined);
  mocks.admin.mockImplementation(() => ({
    auth: { admin: {
      getUserById: mocks.getUserById,
      updateUserById: mocks.updateUserById,
    } },
    from: (table: string) => {
      if (table !== 'profiles') throw Error('Unexpected table');
      let updating: Record<string, unknown> | null = null;
      const chain = {
        select(_cols: string) { return this; },
        eq(field: string, value: unknown) {
          mocks.filters.push([field, value]);
          return this;
        },
        update(values: Record<string, unknown>) {
          updating = values;
          mocks.updateValues.push(values);
          return this;
        },
        maybeSingle: async () => ({ data: mocks.target, error: null }),
        single: async () => {
          if (mocks.updateThrows) throw Error('offline');
          return {
            data: mocks.updateError ? null : { ...mocks.target, ...updating },
            error: mocks.updateError,
          };
        },
      };
      return chain;
    },
  }));
});

describe('PATCH /api/account/members/[userId]/identity', () => {
  it('does not access service role if caller is unauthorized', async () => {
    mocks.requireRole.mockRejectedValue(Error('Forbidden'));
    expect((await PATCH(request(valid), params)).status).toBe(500);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('rejects cross-account membership lookup before touching Auth', async () => {
    mocks.target = null;
    const res = await PATCH(request(valid), params);
    expect(res.status).toBe(404);
    expect(mocks.filters).toContainEqual(['account_id', accountId]);
    expect(mocks.getUserById).not.toHaveBeenCalled();
  });

  it('blocks owner and peer-admin changes, as well as self edits', async () => {
    mocks.target!.account_role = 'owner';
    expect((await PATCH(request(valid), params)).status).toBe(403);
    mocks.target!.account_role = 'admin';
    expect((await PATCH(request(valid), params)).status).toBe(403);
    mocks.requireRole.mockResolvedValue({ userId, accountId, role: 'owner' });
    expect((await PATCH(request(valid), params)).status).toBe(400);
    expect(mocks.updateUserById).not.toHaveBeenCalled();
  });

  it('validates inputs and same-origin for cookie requests', async () => {
    expect((await PATCH(request({ full_name: 'X', email: 'bad' }), params)).status).toBe(400);
    expect((await PATCH(request(valid, 'https://attacker.example'), params)).status).toBe(403);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('updates Auth and the account-scoped profile and logs no e-mail content', async () => {
    const res = await PATCH(request(valid), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true, email_changed: true,
      member: { user_id: userId, full_name: 'Nome Atualizado', email: 'new@example.com' },
    });
    expect(mocks.updateUserById).toHaveBeenCalledWith(userId, {
      email: 'new@example.com', email_confirm: true,
    });
    expect(mocks.updateValues).toEqual([{ full_name: 'Nome Atualizado', email: 'new@example.com' }]);
    expect(mocks.filters).toContainEqual(['account_id', accountId]);
    expect(JSON.stringify(mocks.writeLog.mock.calls)).not.toContain('new@example.com');
  });

  it('updates only the profile when e-mail is unchanged', async () => {
    const res = await PATCH(request({ full_name: 'Outro Nome', email: 'old@example.com' }), params);
    expect(res.status).toBe(200);
    expect(mocks.updateUserById).not.toHaveBeenCalled();
    expect(mocks.updateValues).toEqual([{ full_name: 'Outro Nome', email: 'old@example.com' }]);
  });

  it('does not update profile if Auth rejects a duplicated e-mail', async () => {
    mocks.updateUserById.mockResolvedValue({ data: null, error: { code: 'email_exists', message: 'already exists' } });
    const res = await PATCH(request(valid), params);
    expect(res.status).toBe(409);
    expect(mocks.updateValues).toHaveLength(0);
  });

  it('rolls Auth back if profile cannot be updated', async () => {
    mocks.updateError = { code: '42501' };
    expect((await PATCH(request(valid), params)).status).toBe(500);
    expect(mocks.updateUserById).toHaveBeenNthCalledWith(1, userId, {
      email: 'new@example.com', email_confirm: true,
    });
    expect(mocks.updateUserById).toHaveBeenNthCalledWith(2, userId, {
      email: 'old@example.com', email_confirm: true,
    });
    expect(mocks.writeLog).not.toHaveBeenCalled();
  });

  it('also rolls back when profile update throws a network error', async () => {
    mocks.updateThrows = true;
    expect((await PATCH(request(valid), params)).status).toBe(500);
    expect(mocks.updateUserById).toHaveBeenCalledTimes(2);
  });
});
