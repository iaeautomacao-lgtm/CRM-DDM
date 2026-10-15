import { beforeEach, describe, expect, it, vi } from 'vitest';

// /api/disparador/engine: permissão campaigns.rate_limit, leitura do efetivo, gravação com mescla e auditoria só do que mudou.
const A = 'acc-1';
const hoisted = vi.hoisted(() => ({
  forbidden: false,
  rows: [] as Array<{ account_id: string; batch_claim: boolean | null; tick_chain: boolean | null }>,
  upserts: [] as any[],
  audits: [] as any[],
  permissions: [] as string[],
}));

vi.mock('@/lib/disparador/route-auth', () => ({
  requireDisparadorAccess: vi.fn(async (permission: string) => {
    hoisted.permissions.push(permission);
    if (hoisted.forbidden) {
      const { ForbiddenError } = await import('@/lib/auth/account');
      throw new ForbiddenError('Seu papel não permite gerenciar campanhas do disparador.', permission as 'campaigns.rate_limit');
    }
    return { accountId: A, userId: 'U1', role: 'admin', permissions: new Set(['campaigns.rate_limit']) };
  }),
}));
vi.mock('@/lib/audit/log-event', () => ({ logAuditEvent: vi.fn(async (a: unknown) => void hoisted.audits.push(a)) }));
vi.mock('@/lib/disparador/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'limit']) chain[m] = () => chain;
      chain.upsert = (payload: any) => {
        hoisted.upserts.push(payload);
        const i = hoisted.rows.findIndex((r) => r.account_id === payload.account_id);
        const row = { account_id: payload.account_id, batch_claim: payload.batch_claim, tick_chain: payload.tick_chain };
        if (i >= 0) hoisted.rows[i] = row;
        else hoisted.rows.push(row);
        return Promise.resolve({ error: null });
      };
      chain.then = (resolve: (v: unknown) => void) => resolve({ data: hoisted.rows.map((r) => ({ ...r })), error: null });
      return chain;
    },
  }),
}));

import { GET, PUT } from './route';

const put = (body: unknown) => PUT(new Request('http://x/api/disparador/engine', { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }));

beforeEach(() => {
  hoisted.forbidden = false;
  hoisted.rows = [];
  hoisted.upserts = [];
  hoisted.audits = [];
  hoisted.permissions = [];
  vi.stubEnv('DISPARADOR_BATCH_CLAIM', '');
  vi.stubEnv('DISPARADOR_TICK_CHAIN', '');
});

describe('/api/disparador/engine', () => {
  it('exige campaigns.rate_limit nas duas rotas; sem a permissão = 403 e nada é gravado', async () => {
    hoisted.forbidden = true;
    expect((await GET()).status).toBe(403);
    expect((await put({ batch_claim: true })).status).toBe(403);
    expect(hoisted.permissions).toEqual(['campaigns.rate_limit', 'campaigns.rate_limit']);
    expect(hoisted.upserts).toHaveLength(0);
  });

  it('GET: sem linha tudo segue o ambiente (desligado); mostra o efetivo e a origem', async () => {
    const body = await (await GET()).json();
    expect(body.account).toEqual({ batch_claim: null, tick_chain: null });
    expect(body.effective).toEqual({ batch_claim: { enabled: false, source: 'default' }, tick_chain: { enabled: false, source: 'default' } });
    expect(body.env).toEqual({ batch_claim: false, tick_chain: false });
  });

  it('PUT liga o lote para a conta, devolve o efetivo e audita a mudança (antes → depois)', async () => {
    const res = await put({ batch_claim: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.account).toEqual({ batch_claim: true, tick_chain: null });
    expect(body.effective.batch_claim).toEqual({ enabled: true, source: 'account' });
    expect(hoisted.upserts[0]).toMatchObject({ account_id: A, batch_claim: true, tick_chain: null, updated_by: 'U1' });
    expect(hoisted.audits).toHaveLength(1);
    expect(hoisted.audits[0]).toMatchObject({ accountId: A, action: 'dispatch.engine_flags_changed', changes: { batch_claim: { before: null, after: true } } });
  });

  it('PUT mescla com o que já existe e null volta a seguir o ambiente; repetir o mesmo valor não audita', async () => {
    hoisted.rows = [{ account_id: A, batch_claim: true, tick_chain: true }];
    await put({ tick_chain: null });
    expect(hoisted.rows[0]).toEqual({ account_id: A, batch_claim: true, tick_chain: null });
    hoisted.audits = [];
    await put({ batch_claim: true });
    expect(hoisted.audits).toHaveLength(0);
  });

  it('ambiente ligado + conta desligando: a conta vence e a resposta diz a origem', async () => {
    vi.stubEnv('DISPARADOR_TICK_CHAIN', '1');
    const body = await (await put({ tick_chain: false })).json();
    expect(body.effective.tick_chain).toEqual({ enabled: false, source: 'account' });
    expect(body.env.tick_chain).toBe(true);
  });

  it('corpo inválido = 400 com mensagem; JSON ruim = 400', async () => {
    expect((await put({})).status).toBe(400);
    expect((await put({ batch_claim: 'sim' })).status).toBe(400);
    expect((await put('{x')).status).toBe(400);
    expect(hoisted.upserts).toHaveLength(0);
  });
});
