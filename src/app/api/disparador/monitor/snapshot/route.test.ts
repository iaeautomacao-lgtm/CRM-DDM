import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock('@/lib/disparador/route-auth', () => ({ requireDisparadorAccess: mocks.access }));
vi.mock('@/lib/disparador/admin-client', () => ({ supabaseAdmin: () => ({ marker: 'db' }) }));
vi.mock('@/lib/disparador/monitor-snapshot', () => ({ getMonitorSnapshot: mocks.snapshot }));

import { GET } from './route';

describe('GET /api/disparador/monitor/snapshot', () => {
  beforeEach(() => {
    mocks.access.mockReset();
    mocks.snapshot.mockReset();
  });

  it('só owner/admin: sem permissão 403 e sem tocar no banco', async () => {
    mocks.access.mockRejectedValue(new ForbiddenError('Seu papel não permite gerenciar campanhas do disparador.'));
    const res = await GET();
    expect(res.status).toBe(403);
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/);
  });

  it('sem sessão: 401', async () => {
    mocks.access.mockRejectedValue(new UnauthorizedError());
    expect((await GET()).status).toBe(401);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it('usa SEMPRE a conta da sessão (nenhum parâmetro do cliente) e devolve o snapshot sem cache de navegador', async () => {
    mocks.access.mockResolvedValue({ accountId: 'ACC-1', role: 'admin' });
    mocks.snapshot.mockResolvedValue({ generatedAt: 'x', numbers: [], campaigns: [] });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(await res.json()).toEqual({ ok: true, snapshot: { generatedAt: 'x', numbers: [], campaigns: [] } });
    expect(mocks.snapshot).toHaveBeenCalledWith({ marker: 'db' }, 'ACC-1');
  });

  it('falha interna vira erro HTTP sem vazar detalhes', async () => {
    mocks.access.mockResolvedValue({ accountId: 'ACC-1', role: 'admin' });
    mocks.snapshot.mockRejectedValue(new Error('connection string postgres://secret'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });
});
