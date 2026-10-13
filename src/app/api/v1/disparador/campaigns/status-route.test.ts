import { beforeEach, describe, expect, it, vi } from 'vitest';

// Validação da rota REAL de acompanhamento, sem campanhas de produção.
const st = vi.hoisted(() => ({
  campaign: null as null | Record<string, unknown>,
  metrics: null as null | Record<string, unknown>,
  stats: [] as Array<{ status: string; qty: number }>,
  queries: [] as Array<{ table: string; filters: Record<string, unknown> }>,
  statsCalls: 0,
}));

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({ accountId: 'acct-1', keyId: 'key-1', scopes: ['campaigns:read'] }),
}));

vi.mock('@/lib/api/v1/log', () => ({ logPublicApiCall: () => undefined }));

vi.mock('@/lib/disparador/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        maybeSingle: async () => {
          st.queries.push({ table, filters: { ...filters } });
          if (table === 'campaigns') {
            const c = st.campaign;
            const isOwn = c?.id === filters.id && c?.account_id === filters.account_id;
            return { data: isOwn ? c : null, error: null };
          }
          if (table === 'campaign_metrics_live') {
            const isSame = st.campaign?.id === filters.campaign_id;
            return { data: isSame ? st.metrics : null, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
    rpc: async () => {
      st.statsCalls++;
      return { data: st.stats, error: null };
    },
  }),
}));

const { GET } = await import('./[id]/route');
const ID = '11111111-1111-4111-8111-111111111111';

function request(id = ID) {
  return GET(new Request('https://example.invalid/api/v1/disparador/campaigns/' + id), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  st.campaign = null;
  st.metrics = null;
  st.stats = [];
  st.queries.length = 0;
  st.statsCalls = 0;
});

describe('GET /api/v1/disparador/campaigns/{id}', () => {
  it('campanha inexistente responde 404 sem consultar métricas', async () => {
    const response = await request();
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('not_found');
    expect(st.statsCalls).toBe(0);
    expect(st.queries).toEqual([{ table: 'campaigns', filters: { id: ID, account_id: 'acct-1' } }]);
  });

  it('campanha de outra conta também responde 404, sem expor detalhes', async () => {
    st.campaign = { id: ID, account_id: 'acct-2', nome: 'Privada' };
    const response = await request();
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('not_found');
    expect(JSON.stringify(body)).not.toContain('Privada');
    expect(st.statsCalls).toBe(0);
  });

  it('campanha da conta devolve totais e fila no envelope público', async () => {
    st.campaign = {
      id: ID, account_id: 'acct-1', nome: 'Campanha de teste', status: 'em_execucao',
      created_at: '2026-10-13T12:00:00Z', janela_inicio: '08:00', janela_fim: '18:00',
    };
    st.metrics = {
      total_contatos: 10, total_enviados: 7, total_entregues: 6, total_lidos: 4, total_erros: 1,
    };
    st.stats = [{ status: 'agendado', qty: 2 }, { status: 'entregue', qty: 6 }, { status: 'erro', qty: 1 }];
    const response = await request();
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      campaign_id: ID, name: 'Campanha de teste', status: 'em_execucao',
      window: { start: '08:00', end: '18:00' },
      metrics: { total_contacts: 10, sent: 7, delivered: 6, read: 4, errors: 1, pending: 2 },
      queue: { agendado: 2, enviando: 0, entregue: 6, erro: 1, cancelado: 0 },
    });
    expect(st.queries[0]).toEqual({ table: 'campaigns', filters: { id: ID, account_id: 'acct-1' } });
    expect(st.statsCalls).toBe(1);
  });
});
