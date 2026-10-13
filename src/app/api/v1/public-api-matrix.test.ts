import { beforeEach, describe, expect, it, vi } from 'vitest';

// Teste transversal da API pública: exerce os handlers reais, mas nunca alcança
// um banco, provedor WhatsApp ou fila de campanhas. Os testes de operações
// autenticadas usam contexto sintético e credenciais fictícias.
const st = vi.hoisted(() => ({
  authenticated: false,
  scopes: [] as string[],
  observedScopes: [] as Array<string | string[] | undefined>,
  tableAccesses: [] as string[],
  rpcNames: [] as string[],
  exposeConversation: false,
}));

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('@/lib/auth/api-context', async () => {
  const { unauthorized, forbidden } = await import('@/lib/api/v1/respond');

  function fakeDatabase() {
    return {
      from(table: string) {
        st.tableAccesses.push(table);
        let selectedId: string | undefined;
        const q: Record<string, (...args: unknown[]) => unknown> = {};
        for (const method of ['select', 'in', 'is', 'or', 'order', 'limit', 'gte', 'lt', 'not', 'range']) {
          q[method] = () => q;
        }
        q.eq = (key: unknown, value: unknown) => {
          if (key === 'id' && typeof value === 'string') selectedId = value;
          return q;
        };
        q.then = (resolve: unknown) => {
          const rows = st.exposeConversation && table === 'conversations' && selectedId === CONVERSATION_ID
            ? [{ id: CONVERSATION_ID }]
            : [];
          return (resolve as (v: unknown) => unknown)({ data: rows, error: null });
        };
        q.maybeSingle = async () => ({ data: null, error: null });
        q.single = async () => ({ data: null, error: null });
        return q;
      },
      rpc: async (name: string) => {
        st.rpcNames.push(name);
        return { data: [], error: null };
      },
      storage: { from: () => ({ createSignedUrls: async () => ({ data: [], error: null }) }) },
    };
  }

  return {
    requireApiKey: async (_request: Request, required?: string | string[]) => {
      st.observedScopes.push(required);
      if (!st.authenticated) throw unauthorized();
      if (required) {
        const anyAllowed = (Array.isArray(required) ? required : [required]).some((scope) => st.scopes.includes(scope));
        if (!anyAllowed) throw forbidden('The API key lacks the required scope');
      }
      return {
        authType: 'api_key' as const,
        accountId: 'acct-test',
        keyId: 'key-test',
        scopes: [...st.scopes],
        createdBy: null,
        userId: null,
        supabase: fakeDatabase(),
      };
    },
  };
});

vi.mock('@/lib/api-keys/store', () => ({
  getAccountName: async () => 'Test Account',
}));

vi.mock('@/lib/api/v1/log', () => ({ logPublicApiCall: () => undefined }));
vi.mock('@/lib/api/v1/extract-audit', () => ({ auditExtraction: async () => undefined }));

type RouteContext = { params: Promise<{ id: string }> };
type Handler = (request: Request, ctx?: RouteContext) => Promise<Response>;
type HttpMethod = 'GET' | 'POST';

const routes = [
  { operationId: 'getMe', method: 'GET', path: '/me', scope: undefined, load: () => import('./me/route') },
  { operationId: 'sendWhatsappMessage', method: 'POST', path: '/whatsapp/send', scope: 'messages:send', load: () => import('./whatsapp/send/route') },
  { operationId: 'createCampaign', method: 'POST', path: '/disparador/campaigns', scope: 'campaigns:write', load: () => import('./disparador/campaigns/route') },
  { operationId: 'getCampaign', method: 'GET', path: '/disparador/campaigns/' + CONVERSATION_ID, scope: ['campaigns:read', 'campaigns:write'], load: () => import('./disparador/campaigns/[id]/route') },
  { operationId: 'getReportOperationsCurrent', method: 'GET', path: '/reports/operations/current', scope: 'reports:read', load: () => import('./reports/operations/current/route') },
  { operationId: 'getReportOperationsSummary', method: 'GET', path: '/reports/operations/summary', scope: 'reports:read', load: () => import('./reports/operations/summary/route') },
  { operationId: 'getReportTeams', method: 'GET', path: '/reports/teams', scope: 'reports:read', load: () => import('./reports/teams/route') },
  { operationId: 'getReportAgents', method: 'GET', path: '/reports/agents', scope: 'reports:read', load: () => import('./reports/agents/route') },
  { operationId: 'getReportTabulations', method: 'GET', path: '/reports/tabulations', scope: 'reports:read', load: () => import('./reports/tabulations/route') },
  { operationId: 'listConversations', method: 'GET', path: '/conversations', scope: 'conversations:read', load: () => import('./conversations/route') },
  { operationId: 'listConversationMessages', method: 'GET', path: '/conversations/' + CONVERSATION_ID + '/messages', scope: 'messages:read', load: () => import('./conversations/[id]/messages/route') },
  { operationId: 'listMessages', method: 'GET', path: '/messages?from=2026-10-01&to=2026-10-02', scope: 'messages:read', load: () => import('./messages/route') },
] as const;

function request(path: string, method: HttpMethod): Request {
  return new Request('https://example.invalid/api/v1' + path, {
    method,
    ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
  });
}

async function call(item: (typeof routes)[number], path: string = item.path): Promise<Response> {
  const mod = (await item.load()) as unknown as Record<HttpMethod, Handler>;
  return mod[item.method](request(path, item.method), { params: Promise.resolve({ id: CONVERSATION_ID }) });
}

async function expectError(res: Response, status: number, code: string): Promise<void> {
  expect(res.status).toBe(status);
  const body = await res.json();
  expect(body).toEqual({ error: { code, message: expect.any(String) } });
  expect(body).not.toHaveProperty('data');
}

beforeEach(() => {
  st.authenticated = false;
  st.scopes.length = 0;
  st.observedScopes.length = 0;
  st.tableAccesses.length = 0;
  st.rpcNames.length = 0;
  st.exposeConversation = false;
});

describe('API pública V1: matriz de autenticação e escopos em TODOS os handlers', () => {
  it('cobre 100% das 12 operações do contrato OpenAPI', async () => {
    const { openApiSpec } = await import('@/lib/api/v1/openapi');
    const specOps = Object.values(openApiSpec.paths).flatMap((entry) =>
      Object.values(entry).filter((op): op is { operationId: string } =>
        Boolean(op && typeof op === 'object' && 'operationId' in op))
        .map((op) => op.operationId)
    ).sort();
    expect(routes.map((r) => r.operationId).sort()).toEqual(specOps);
  });

  it.each(routes)('$method $operationId retorna 401 sem chave ANTES de consultar banco', async (item) => {
    await expectError(await call(item), 401, 'unauthorized');
    expect(st.observedScopes).toEqual([item.scope]);
    expect(st.tableAccesses).toHaveLength(0);
    expect(st.rpcNames).toHaveLength(0);
  });

  it.each(routes.filter((item) => item.scope !== undefined))(
    '$method $operationId retorna 403 quando a chave nao tem o escopo',
    async (item) => {
      st.authenticated = true;
      await expectError(await call(item), 403, 'forbidden');
      expect(st.observedScopes).toEqual([item.scope]);
      expect(st.tableAccesses).toHaveLength(0);
      expect(st.rpcNames).toHaveLength(0);
    },
  );

  it('GET /me aceita chave válida mesmo sem escopos e usa envelope documentado', async () => {
    st.authenticated = true;
    const res = await call(routes[0]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ account: { id: 'acct-test', name: 'Test Account' }, key: { id: 'key-test', scopes: [] } });
  });

  it('GET /openapi.json e público e informa as 12 operações do contrato', async () => {
    const { GET } = await import('./openapi.json/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toBe('3.1.0');
    expect(body.servers?.[0]?.url).toMatch(/\/api\/v1$/);
    expect(body.paths['/messages']?.get?.operationId).toBe('listMessages');
    expect(body.paths['/whatsapp/send']?.post?.operationId).toBe('sendWhatsappMessage');
  });
});

describe('API pública V1: rotas somente leitura com dados sintéticos', () => {
  it.each([
    ['/reports/operations/current', 'reports:read'],
    ['/reports/operations/summary?from=2026-10-01&to=2026-10-02', 'reports:read'],
    ['/reports/teams?from=2026-10-01&to=2026-10-02', 'reports:read'],
    ['/reports/agents?from=2026-10-01&to=2026-10-02', 'reports:read'],
    ['/reports/tabulations?from=2026-10-01&to=2026-10-02', 'reports:read'],
    ['/conversations?limit=2', 'conversations:read'],
    ['/messages?from=2026-10-01&to=2026-10-02&limit=2', 'messages:read'],
  ])('GET %s retorna 200 sem executar operacoes de escrita', async (path, scope) => {
    st.authenticated = true;
    st.scopes.push(scope);
    const target = routes.find((r) => path.startsWith(r.path.split('?')[0]));
    expect(target).toBeDefined();
    const res = await call(target!, path);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('data');
    expect(body).not.toHaveProperty('error');
  });

  it('historico de uma conversa pertence a conta da chave', async () => {
    st.authenticated = true;
    st.scopes.push('messages:read');
    st.exposeConversation = false;
    const route = routes.find((r) => r.operationId === 'listConversationMessages')!;
    await expectError(await call(route), 404, 'not_found');
    st.exposeConversation = true;
    const response = await call(route);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({ items: [], next_cursor: null });
    expect(st.rpcNames).toContain('api_v1_messages');
  });

  it.each([
    ['/reports/operations/current?team_id=invalid', 'getReportOperationsCurrent'],
    ['/reports/operations/summary', 'getReportOperationsSummary'],
    ['/reports/teams?from=2026-10-08&to=2026-10-02', 'getReportTeams'],
    ['/reports/agents?from=ontem&to=2026-10-02', 'getReportAgents'],
    ['/reports/tabulations?from=2025-01-01&to=2026-10-02', 'getReportTabulations'],
  ])('GET %s rejeita filtro inválido antes de acessar dados', async (path, operation) => {
    st.authenticated = true;
    st.scopes.push('reports:read');
    const route = routes.find((r) => r.operationId === operation)!;
    await expectError(await call(route, path), 400, 'bad_request');
    expect(st.tableAccesses).toHaveLength(0);
  });
});
