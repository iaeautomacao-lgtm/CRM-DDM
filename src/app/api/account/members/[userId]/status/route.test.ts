// POST /api/account/members/[userId]/status (TASK3): permissão members.manage, nunca a si mesmo, validação do corpo.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { can, type Permission } from '@/lib/auth/permissions';
import type { AccountRole } from '@/lib/auth/roles';

const ME = '00000000-0000-0000-0000-0000000000a1';
const TARGET = '00000000-0000-0000-0000-0000000000b2';
const state = vi.hoisted(() => ({ role: 'admin' as string }));
const svc = vi.hoisted(() => ({ setMemberActive: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requirePermission: async (p: Permission) => {
    if (!can({ role: state.role as AccountRole }, p)) throw Object.assign(new Error('Sem permissão'), { status: 403 });
    return { accountId: 'acc', userId: '00000000-0000-0000-0000-0000000000a1', role: state.role };
  },
  toErrorResponse: (err: { status?: number; message?: string }) => NextResponse.json({ error: err.message }, { status: err.status ?? 500 }),
}));
vi.mock('@/lib/account/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: async () => ({ success: true }),
  rateLimitResponse: () => NextResponse.json({}, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}));
vi.mock('@/lib/members/member-status', () => ({
  setMemberActive: svc.setMemberActive,
  MemberStatusError: class MemberStatusError extends Error {
    constructor(m: string, public status: number) {
      super(m);
    }
  },
}));

const { POST } = await import('./route');
const post = (id: string, body: unknown) =>
  POST(new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ userId: id }) });

beforeEach(() => {
  state.role = 'admin';
  svc.setMemberActive.mockReset();
  svc.setMemberActive.mockResolvedValue({ was_active: true, is_active: false, role: 'agent', sessions_revoked: 1 });
});

describe('POST /api/account/members/[userId]/status', () => {
  it('admin desativa outro membro', async () => {
    const res = await post(TARGET, { active: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, is_active: false, sessions_revoked: 1 });
    expect(svc.setMemberActive).toHaveBeenCalledWith(expect.anything(), { accountId: 'acc', actorId: ME, targetId: TARGET, active: false });
  });

  it('supervisor não pode; a si mesmo → 403; corpo inválido → 400; id inválido → 404', async () => {
    state.role = 'supervisor';
    expect((await post(TARGET, { active: false })).status).toBe(403);
    state.role = 'admin';
    expect((await post(ME, { active: false })).status).toBe(403);
    expect((await post(TARGET, { active: 'nao' })).status).toBe(400);
    expect((await post('x', { active: false })).status).toBe(404);
    expect(svc.setMemberActive).not.toHaveBeenCalled();
  });
});
