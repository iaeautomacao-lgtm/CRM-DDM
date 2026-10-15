import { beforeEach, describe, expect, it, vi } from 'vitest';

// A1 — leitura de campanhas pela API pública: lista, detalhe enriquecido e recipients. Banco e dependências simulados.
const ACC = 'acc-1';
const CAMP = '7c9e6679-0000-4000-8000-000000000020';
let tables: Record<string, any[]> = {};
let rpcRows: any[] = [];
let scopeError: Error | null = null;
const audits: any[] = [];
const requiredScopes: unknown[] = [];

function from(table: string) {
  const eqs: Array<[string, unknown]> = [];
  let maybe = false;
  const chain: any = {};
  for (const m of ['select', 'in', 'gte', 'lt', 'or', 'not', 'like', 'order', 'limit', 'is']) chain[m] = () => chain;
  chain.eq = (c: string, v: unknown) => (eqs.push([c, v]), chain);
  chain.maybeSingle = () => ((maybe = true), chain);
  chain.then = (resolve: (v: unknown) => void) => {
    const rows = (tables[table] ?? []).filter((r) => eqs.every(([c, v]) => r[c] === v));
    resolve({ data: maybe ? (rows[0] ?? null) : rows, error: null, count: rows.length });
  };
  return chain;
}

vi.mock('@/lib/api/v1/log', () => ({ logPublicApiCall: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async (_req: Request, scope: unknown) => {
    requiredScopes.push(scope);
    if (scopeError) throw scopeError;
    return { accountId: ACC, keyId: 'key-1', createdBy: 'u1', supabase: { from } };
  }),
}));
vi.mock('@/lib/disparador/admin-client', () => ({ supabaseAdmin: () => ({ from, rpc: async () => ({ data: rpcRows, error: null }) }) }));
vi.mock('@/lib/api/v1/extract-audit', () => ({ auditExtraction: vi.fn(async (a: unknown) => void audits.push(a)) }));
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: vi.fn(async () => ({ success: true, remaining: 59, reset: 0, limit: 60 })),
}));
vi.mock('@/lib/disparador/queue-details-rows', () => ({ loadContactConversationIds: vi.fn(async () => new Map([['c1', 'conv-1']])) }));
vi.mock('@/lib/disparador/channel-label', () => ({
  loadChannelIdentities: vi.fn(async () => [{ id: 's1', provider: 'waha', label: 'Linha 1 · +55 21 3030-9159' }]),
}));
vi.mock('@/lib/utmpay/stats', () => ({
  loadCampaignFunnel: vi.fn(async () => ({
    available: true,
    tracking: true,
    entregues: 10,
    links: 8,
    clicou: 4,
    fechou: 2,
    pagou: 1,
    taxas: { clicou: 0.4, fechou: 0.2, pagou: 0.1 },
    por_atribuicao: { fechou: { direto: 1, ia: 1, humano: 0 }, pagou: { direto: 0, ia: 0, humano: 1 } },
    por_atendente: [],
  })),
  loadItemResults: vi.fn(async () => new Map()),
}));

import { ApiError } from '@/lib/api/v1/respond';
import { GET as listGET } from './route';
import { GET as detailGET } from './[id]/route';
import { GET as recipientsGET } from './[id]/recipients/route';

const req = (path: string) => new Request(`http://x/api/v1/disparador/campaigns${path}`, { headers: { authorization: 'Bearer k' } });
const ctx = (id = CAMP) => ({ params: Promise.resolve({ id }) });

const campaign = {
  id: CAMP,
  account_id: ACC,
  nome: 'Cobrança',
  status: 'pausada',
  created_at: '2026-10-07T13:17:05Z',
  janela_inicio: '08:00:00',
  janela_fim: '18:00:00',
  source: 'api_v1',
  idempotency_key: 'lote-3',
  session_ids: ['s1'],
  mensagens: [{ tipo: 'texto', template_name: 'promo', template_language: 'pt_BR' }],
  agendamento: '2026-10-07T13:17:06Z',
  callback_url: 'https://erp.exemplo.com.br/hook?secret=1',
  pausa_automatica_motivo: 'Taxa de erro alta',
  pausa_template_nome: null,
  pausa_template_idioma: null,
};

beforeEach(() => {
  scopeError = null;
  requiredScopes.length = 0;
  audits.length = 0;
  rpcRows = [
    { campaign_id: CAMP, status: 'agendado', qty: 6 },
    { campaign_id: CAMP, status: 'entregue', qty: 3 },
    { campaign_id: CAMP, status: 'lido', qty: 1 },
  ];
  tables = {
    campaigns: [campaign, { ...campaign, id: 'outra', account_id: 'acc-2' }],
    campaign_metrics_live: [{ campaign_id: CAMP, total_contatos: 10, total_enviados: 4, total_entregues: 3, total_lidos: 1, total_erros: 0 }],
    whatsapp_config: [{ id: 's1', account_id: ACC, provider: 'waha', waha_session: 'brdid_1' }],
    disp_message_queue: [
      { id: 'i1', campaign_id: CAMP, contact_id: null, mensagem_final: '5521999998888', status: 'entregue', scheduled_at: '2026-10-07T13:20:00Z', sent_at: '2026-10-07T13:20:03Z', replied_at: null, erro: null, erro_codigo: null, contacts: null },
      { id: 'i2', campaign_id: CAMP, contact_id: 'c1', mensagem_final: 'texto', status: 'erro', scheduled_at: '2026-10-07T13:21:00Z', sent_at: null, replied_at: '2026-10-07T14:00:00Z', erro: '(#131026) falha', erro_codigo: 131026, contacts: { name: 'Maria', phone: '+5521988887777' } },
    ],
  };
});

describe('GET /disparador/campaigns (lista)', () => {
  it('exige campaigns:read ou campaigns:write e só traz campanhas da conta', async () => {
    const res = await listGET(req(''));
    expect(res.status).toBe(200);
    expect(requiredScopes[0]).toEqual(['campaigns:read', 'campaigns:write']);
    const body = await res.json();
    expect(body.data.items.map((i: any) => i.campaign_id)).toEqual([CAMP]);
    expect(body.data.items[0]).toMatchObject({ source: 'api_v1', external_id: 'lote-3', status: 'pausada', paused_reason: 'Taxa de erro alta', provider: 'waha', message_type: 'template' });
    expect(body.data.next_cursor).toBeNull();
  });
  it('chave sem escopo = 403 no envelope; filtro inválido = 400', async () => {
    scopeError = new ApiError('forbidden', 'Chave sem o escopo exigido', 403);
    const forbidden = await listGET(req(''));
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe('forbidden');
    scopeError = null;
    const bad = await listGET(req('?status=ativa'));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe('bad_request');
  });
});

describe('GET /disparador/campaigns/{id} (detalhe)', () => {
  it('mantém os campos de sempre e acrescenta os novos, sem vazar a callback_url', async () => {
    const res = await detailGET(req(`/${CAMP}`), ctx());
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(d).toMatchObject({ campaign_id: CAMP, name: 'Cobrança', status: 'pausada', window: { start: '08:00:00', end: '18:00:00' } });
    expect(d.metrics).toMatchObject({ total_contacts: 10, sent: 4, delivered: 3, read: 1, pending: 6 });
    expect(d.queue).toMatchObject({ agendado: 6, entregue: 3, lido: 1, pendente: 0, pausado: 0, bloqueado: 0, erro: 0, enviando: 0, cancelado: 0 });
    expect(d).toMatchObject({
      source: 'api_v1',
      external_id: 'lote-3',
      provider: 'waha',
      message_type: 'template',
      channel: { id: 's1', label: 'Linha 1 · +55 21 3030-9159', waha_session: 'brdid_1' },
      template: { name: 'promo', language: 'pt_BR' },
      callback_configured: true,
      pause: { automatic: true, reason: 'Taxa de erro alta', template: null },
    });
    expect(d.funnel).toMatchObject({ clicked: 4, closed: 2, paid: 1 });
    expect(JSON.stringify(d)).not.toContain('erp.exemplo.com.br');
  });
  it('campanha de outra conta ou inexistente = 404', async () => {
    expect((await detailGET(req('/outra'), ctx('outra'))).status).toBe(404);
    expect((await detailGET(req('/zzz'), ctx('zzz'))).status).toBe(404);
  });
});

describe('GET /disparador/campaigns/{id}/recipients', () => {
  it('devolve status atual por destinatário, audita só a quantidade e nunca devolve CPF/texto', async () => {
    const res = await recipientsGET(req(`/${CAMP}/recipients?limit=10`), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items[0]).toMatchObject({ recipient_id: 'i1', phone: '5521999998888', status: 'delivered', contact_id: null });
    expect(body.data.items[1]).toMatchObject({ recipient_id: 'i2', name: 'Maria', status: 'error', error: { code: 131026, type: 'Janela 24h' }, conversation_id: 'conv-1' });
    expect(JSON.stringify(body)).not.toMatch(/cpf|mensagem_final/i);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ route: '/api/v1/disparador/campaigns/[id]/recipients', itemCount: 2 });
  });
  it('campanha de outra conta = 404; id que não é UUID = 404; filtro inválido = 400; cursor de outro modo = 400', async () => {
    expect((await recipientsGET(req('/outra/recipients'), ctx('outra'))).status).toBe(404);
    expect((await recipientsGET(req('/x/recipients'), ctx('x'))).status).toBe(404);
    expect((await recipientsGET(req(`/${CAMP}/recipients?status=ok`), ctx())).status).toBe(400);
    const cursor = Buffer.from(JSON.stringify(['2026-10-07T13:20:00.000Z', 'i1'])).toString('base64url');
    expect((await recipientsGET(req(`/${CAMP}/recipients?paid=true&cursor=${cursor}`), ctx())).status).toBe(400);
  });
  it('sem escopo = 403', async () => {
    scopeError = new ApiError('forbidden', 'Chave sem o escopo exigido', 403);
    expect((await recipientsGET(req(`/${CAMP}/recipients`), ctx())).status).toBe(403);
  });
});
