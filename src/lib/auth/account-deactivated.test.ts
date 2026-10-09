// TASK3: getCurrentAccount recusa perfil desativado (403 code member_deactivated) — vale enquanto o token antigo vive.
import { describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ profile: { account_id: 'acc', account_role: 'agent', deactivated_at: null as string | null } }));

vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => undefined }) }));
vi.mock('@/lib/audit/context', () => ({ auditFetch: fetch, registerAuditActor: vi.fn(async () => undefined) }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'u1', factors: [] } }, error: null }),
      getSession: async () => ({ data: { session: null } }),
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: table === 'profiles' ? fake.profile : null, error: null }),
          limit: async () => ({ data: [{ id: 'acc', name: 'Conta' }], error: null }),
        }),
      }),
    }),
  }),
}));

describe('getCurrentAccount × membro desativado', () => {
  it('ativo passa; desativado → MemberDeactivatedError → 403 { code: member_deactivated }', async () => {
    const { getCurrentAccount, MemberDeactivatedError, toErrorResponse } = await import('./account');
    fake.profile.deactivated_at = '2026-10-09T10:00:00Z';
    const err = await getCurrentAccount().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemberDeactivatedError);
    const res = toErrorResponse(err);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('member_deactivated');
  });

  it('perfil sem a coluna (antes da 311) segue funcionando', async () => {
    const { getCurrentAccount, MemberDeactivatedError } = await import('./account');
    fake.profile = { account_id: 'acc', account_role: 'agent' } as typeof fake.profile;
    const result = await getCurrentAccount().catch((e: unknown) => e);
    expect(result).not.toBeInstanceOf(MemberDeactivatedError);
  });
});
