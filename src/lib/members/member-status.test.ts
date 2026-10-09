// TASK3: serviço de desativar/reativar membro (RPC + banimento no Supabase Auth + auditoria).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const audit = vi.hoisted(() => ({ logAuditEvent: vi.fn<(e: unknown) => Promise<void>>(async () => undefined) }));
vi.mock('@/lib/audit/log-event', () => audit);

const { BAN_FOREVER, MemberStatusError, setMemberActive } = await import('./member-status');

function deps(rpc: { data?: unknown; error?: { code?: string; message?: string } | null }, banError: { message: string } | null = null) {
  const calls = { rpc: [] as unknown[], ban: [] as unknown[] };
  return {
    calls,
    deps: {
      db: { rpc: async (name: string, args: unknown) => (calls.rpc.push([name, args]), { data: rpc.data ?? null, error: rpc.error ?? null }) },
      auth: { auth: { admin: { updateUserById: async (id: string, attrs: unknown) => (calls.ban.push([id, attrs]), { error: banError }) } } },
    } as never,
  };
}

const input = { accountId: 'acc', actorId: 'admin', targetId: 'agent' };

describe('setMemberActive', () => {
  beforeEach(() => audit.logAuditEvent.mockClear());

  it('desativar: RPC, banimento sem prazo e auditoria member.deactivated', async () => {
    const d = deps({ data: { was_active: true, is_active: false, role: 'agent', sessions_revoked: 2 } });
    const out = await setMemberActive(d.deps, { ...input, active: false });
    expect(out).toMatchObject({ is_active: false, sessions_revoked: 2 });
    expect(d.calls.rpc).toEqual([['set_member_active', { p_account: 'acc', p_actor: 'admin', p_target: 'agent', p_active: false }]]);
    expect(d.calls.ban).toEqual([['agent', { ban_duration: BAN_FOREVER }]]);
    expect(audit.logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'member.deactivated', resourceId: 'agent' }));
  });

  it('reativar: tira o banimento e audita member.reactivated', async () => {
    const d = deps({ data: { was_active: false, is_active: true, role: 'agent', sessions_revoked: 0 } });
    await setMemberActive(d.deps, { ...input, active: true });
    expect(d.calls.ban).toEqual([['agent', { ban_duration: 'none' }]]);
    expect(audit.logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'member.reactivated' }));
  });

  it('sem mudança de estado não audita; falha no banimento é sinalizada sem desfazer', async () => {
    const d = deps({ data: { was_active: false, is_active: false, role: 'agent', sessions_revoked: 0 } }, { message: 'boom' });
    const out = await setMemberActive(d.deps, { ...input, active: false });
    expect(out.ban_failed).toBe(true);
    expect(audit.logAuditEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['42501', 403],
    ['P0002', 404],
    ['22023', 400],
    ['XX000', 500],
  ])('erro %s do banco → %i, sem banir', async (code, status) => {
    const d = deps({ error: { code, message: 'x' } });
    const err = await setMemberActive(d.deps, { ...input, active: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemberStatusError);
    expect((err as InstanceType<typeof MemberStatusError>).status).toBe(status);
    expect(d.calls.ban).toEqual([]);
  });
});
