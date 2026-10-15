import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/disparador/channel-label', () => ({ loadChannelIdentities: vi.fn(async () => []) }));
vi.mock('@/lib/utmpay/stats', () => ({
  loadCampaignFunnel: vi.fn(),
  loadItemResults: vi.fn(async () => new Map()),
}));

import {
  API_TO_QUEUE,
  RECIPIENT_STATUSES,
  decodeRecipientCursor,
  emptyQueueCounts,
  foldQueueStats,
  hasFunnelFilter,
  loadCampaignPage,
  loadRecipientPage,
  messageTypeOf,
  parseCampaignListFilters,
  parseRecipientFilters,
  recipientPhone,
  recipientStatusOf,
  toApiFunnel,
  toApiRecipient,
  type RecipientRow,
} from './campaign-api';
import { encodeCursor } from './extract';

const q = (s: string) => new URLSearchParams(s);

// Banco gravador: devolve o que foi pré-carregado por tabela e registra as chamadas encadeadas.
function recorder(data: Record<string, unknown[]>, rpcData: unknown[] = []) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = [];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    const record = (method: string) => (...args: unknown[]) => {
      calls.push({ table, method, args });
      return chain;
    };
    for (const m of ['select', 'eq', 'in', 'gte', 'lt', 'or', 'not', 'like', 'order', 'limit']) chain[m] = record(m);
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: data[table] ?? [], error: null, count: (data[table] ?? []).length });
    return chain;
  };
  return { db: { from, rpc: async () => ({ data: rpcData, error: null }) } as never, calls };
}

describe('filtros da lista de campanhas', () => {
  it('aceita vários status, origem, external_id e período', () => {
    const f = parseCampaignListFilters(q('status=em_execucao,pausada&source=api_v1&external_id=lote-3&created_from=2026-10-01T00:00:00Z&created_to=2026-10-08T00:00:00Z'));
    expect(f.statuses).toEqual(['em_execucao', 'pausada']);
    expect(f.source).toBe('api_v1');
    expect(f.externalId).toBe('lote-3');
    expect(f.createdFrom).toBe('2026-10-01T00:00:00.000Z');
  });
  it('recusa status/origem/período inválidos', () => {
    expect(() => parseCampaignListFilters(q('status=ativa'))).toThrow(/inválido/);
    expect(() => parseCampaignListFilters(q('source=xyz'))).toThrow(/inválido/);
    expect(() => parseCampaignListFilters(q('created_from=2026-10-09T00:00:00Z&created_to=2026-10-01T00:00:00Z'))).toThrow(/anterior/);
    expect(() => parseCampaignListFilters(q(`external_id=${'x'.repeat(129)}`))).toThrow(/128/);
  });
});

describe('filtros e status dos destinatários', () => {
  it('mapa fila → API cobre todos os status da fila e o inverso é consistente', () => {
    for (const s of ['agendado', 'pendente', 'pausado', 'enviando', 'enviado', 'entregue', 'lido', 'erro', 'bloqueado', 'cancelado']) {
      expect(API_TO_QUEUE[recipientStatusOf(s)]).toContain(s);
    }
    expect(recipientStatusOf('desconhecido')).toBe('queued');
    expect(Object.keys(API_TO_QUEUE).sort()).toEqual([...RECIPIENT_STATUSES].sort());
  });
  it('parseia status múltiplo, booleanos e telefone (só dígitos)', () => {
    const f = parseRecipientFilters(q('status=delivered,read&replied=true&paid=1&phone=%2B55%2021%2099999-8888'));
    expect(f).toMatchObject({ statuses: ['delivered', 'read'], replied: true, paid: true, clicked: false, phone: '5521999998888' });
    expect(hasFunnelFilter(f)).toBe(true);
    expect(hasFunnelFilter(parseRecipientFilters(q('replied=true')))).toBe(false);
  });
  it('recusa status, booleano e telefone inválidos', () => {
    expect(() => parseRecipientFilters(q('status=ok'))).toThrow(/inválido/);
    expect(() => parseRecipientFilters(q('paid=talvez'))).toThrow(/true ou false/);
    expect(() => parseRecipientFilters(q('phone=123'))).toThrow(/inválido/);
  });
  it('cursor de fila e de funil não se misturam', () => {
    const queueCursor = encodeCursor(['2026-10-07T13:20:00.000Z', 'abc']);
    const funnelCursor = encodeCursor(['f', '2026-10-07T13:20:00.000Z', 'abc']);
    expect(decodeRecipientCursor(queueCursor, false)).toHaveLength(2);
    expect(decodeRecipientCursor(funnelCursor, true)).toHaveLength(3);
    expect(() => decodeRecipientCursor(queueCursor, true)).toThrow(/não corresponde/);
    expect(() => decodeRecipientCursor(funnelCursor, false)).toThrow(/não corresponde/);
    expect(() => decodeRecipientCursor('lixo', false)).toThrow(/inválido/);
    expect(decodeRecipientCursor(null, false)).toBeNull();
  });
});

describe('serialização', () => {
  const row = (over: Partial<RecipientRow> = {}): RecipientRow => ({
    id: 'item-1',
    contact_id: null,
    mensagem_final: '5521999998888',
    erro: null,
    erro_codigo: null,
    status: 'entregue',
    scheduled_at: '2026-10-07T13:20:00Z',
    sent_at: '2026-10-07T13:20:04Z',
    replied_at: null,
    contacts: null,
    ...over,
  });

  it('contato externo da API: telefone vem de mensagem_final; sem nome nem contact_id', () => {
    const r = toApiRecipient(row(), {});
    expect(r).toMatchObject({ recipient_id: 'item-1', phone: '5521999998888', contact_id: null, name: null, status: 'delivered', status_raw: 'entregue', funnel: null, error: null });
  });
  it('contato do CRM: telefone e nome do contato; mensagem_final (texto) nunca vira telefone', () => {
    const r = toApiRecipient(row({ contact_id: 'c1', mensagem_final: 'Olá, tudo bem?', contacts: { name: 'Maria', phone: '+5521988887777' } }), { conversationId: 'conv-1' });
    expect(r).toMatchObject({ phone: '+5521988887777', name: 'Maria', contact_id: 'c1', conversation_id: 'conv-1' });
    expect(recipientPhone(row({ contact_id: 'c1', contacts: null }))).toBeNull();
    expect(recipientPhone(row({ mensagem_final: 'texto livre' }))).toBeNull();
  });
  it('erro classificado, sem texto técnico; só em status erro', () => {
    const e = toApiRecipient(row({ status: 'erro', erro: '(#131026) Message undeliverable secret-token-123', erro_codigo: 131026 }), {});
    expect(e.error).toEqual({ code: 131026, type: 'Janela 24h' });
    expect(JSON.stringify(e)).not.toContain('secret-token');
    expect(toApiRecipient(row({ status: 'enviado', erro: 'antigo' }), {}).error).toBeNull();
  });
  it('funil: atribuição em inglês e nada de CPF', () => {
    const r = toApiRecipient(row(), {
      result: {
        clicou: true,
        fechou: true,
        pagou: true,
        rastreio: { clicou_em: 'a', fechou_em: 'b', pagou_em: 'c', atribuicao: 'humano', atendente_id: 'u1', atendente_nome: 'Ana', situacao_acordo: 'x', valor_em_aberto: 10, instituicao: 'Y', verificado_em: 'v' },
      },
    });
    expect(r.funnel).toEqual({ clicked: true, closed: true, paid: true, clicked_at: 'a', closed_at: 'b', paid_at: 'c', attribution: 'human', attendant_id: 'u1' });
    expect(JSON.stringify(r)).not.toMatch(/cpf|atendente_nome|valor_em_aberto|instituicao/i);
  });
  it('toApiFunnel só existe com UTMpay disponível e ativo', () => {
    const base = { entregues: 10, links: 8, clicou: 4, fechou: 2, pagou: 1, taxas: { clicou: 0.4, fechou: 0.2, pagou: 0.1 }, por_atribuicao: { fechou: { direto: 1, ia: 1, humano: 0 }, pagou: { direto: 0, ia: 0, humano: 1 } }, por_atendente: [] };
    expect(toApiFunnel({ ...base, available: false, tracking: true })).toBeNull();
    expect(toApiFunnel({ ...base, available: true, tracking: false })).toBeNull();
    expect(toApiFunnel({ ...base, available: true, tracking: true })).toMatchObject({ clicked: 4, closed: 2, paid: 1, by_attribution: { paid: { human: 1 } } });
  });
  it('fila: soma por status e zera o que falta', () => {
    expect(foldQueueStats([{ status: 'agendado', qty: 3 }, { status: 'agendado', qty: '2' }, { status: 'lido', qty: 7 }, { status: 'x', qty: 1 }])).toEqual({ ...emptyQueueCounts(), agendado: 5, lido: 7 });
  });
  it('tipo da mensagem: template Meta, imagem WAHA ou texto', () => {
    expect(messageTypeOf([{ tipo: 'texto', template_name: 'promo' }])).toBe('template');
    expect(messageTypeOf([{ tipo: 'imagem' }])).toBe('image');
    expect(messageTypeOf([{ tipo: 'texto' }])).toBe('text');
    expect(messageTypeOf(null)).toBeNull();
  });
});

describe('loadCampaignPage', () => {
  const camp = (id: string, at: string) => ({ id, nome: id, status: 'em_execucao', source: 'api_v1', idempotency_key: null, created_at: at, janela_inicio: '08:00:00', janela_fim: '18:00:00', session_ids: ['s1'], mensagens: [{ tipo: 'texto', template_name: 'promo' }], pausa_automatica_motivo: 'x' });

  it('pagina com limit+1 e devolve next_cursor; filtros e keyset vão para a consulta; pausa só aparece pausada', async () => {
    const { db, calls } = recorder(
      {
        campaigns: [camp('c3', '2026-10-03T00:00:00Z'), camp('c2', '2026-10-02T00:00:00Z'), camp('c1', '2026-10-01T00:00:00Z')],
        campaign_metrics_live: [{ campaign_id: 'c3', total_contatos: 10, total_enviados: 4, total_entregues: 3, total_lidos: 1, total_erros: 0 }],
        whatsapp_config: [{ id: 's1', provider: 'meta' }],
      },
      [{ campaign_id: 'c3', status: 'agendado', qty: 6 }],
    );
    const filters = parseCampaignListFilters(q('status=em_execucao&source=api_v1'));
    const page = await loadCampaignPage(db, { accountId: 'ACC', filters, cursor: ['2026-10-09T00:00:00.000Z', 'zz'], limit: 2 });
    expect(page.items.map((i) => i.campaign_id)).toEqual(['c3', 'c2']);
    expect(page.next_cursor).not.toBeNull();
    expect(page.items[0]).toMatchObject({ provider: 'meta', message_type: 'template', metrics: { total_contacts: 10, sent: 4, pending: 6 }, paused_reason: null });
    const names = calls.filter((c) => c.table === 'campaigns').map((c) => `${c.method}:${String(c.args[0])}`);
    expect(names).toContain('eq:account_id');
    expect(names).toContain('in:status');
    expect(names).toContain('eq:source');
    expect(calls.find((c) => c.method === 'or')?.args[0]).toContain('created_at.lt."2026-10-09T00:00:00.000Z"');
    expect(calls.find((c) => c.method === 'limit')?.args[0]).toBe(3);
  });

  it('página vazia = sem consultas auxiliares e sem cursor', async () => {
    const { db, calls } = recorder({ campaigns: [] });
    const page = await loadCampaignPage(db, { accountId: 'ACC', filters: parseCampaignListFilters(q('')), cursor: null, limit: 50 });
    expect(page).toEqual({ items: [], next_cursor: null });
    expect(calls.some((c) => c.table === 'campaign_metrics_live')).toBe(false);
  });

  it('campanha pausada mostra o motivo da pausa automática', async () => {
    const { db } = recorder({ campaigns: [{ ...camp('c1', '2026-10-01T00:00:00Z'), status: 'pausada' }], campaign_metrics_live: [], whatsapp_config: [] }, []);
    const page = await loadCampaignPage(db, { accountId: 'ACC', filters: parseCampaignListFilters(q('')), cursor: null, limit: 50 });
    expect(page.items[0].paused_reason).toBe('x');
  });
});

describe('loadRecipientPage', () => {
  const item = (id: string, over: Partial<RecipientRow> = {}) => ({ id, contact_id: null, mensagem_final: '5521999998888', erro: null, erro_codigo: null, status: 'enviado', scheduled_at: '2026-10-07T13:20:00Z', sent_at: null, replied_at: null, contacts: null, ...over });
  const none = async () => new Map<string, string>();

  it('modo fila: ordem por scheduled_at/id, filtro de status traduzido e next_cursor', async () => {
    const { db, calls } = recorder({ disp_message_queue: [item('a'), item('b'), item('c')] });
    const page = await loadRecipientPage(db, {
      accountId: 'ACC', campaignId: 'camp', filters: parseRecipientFilters(q('status=delivered,read&replied=true')), cursor: null, limit: 2, conversationsFor: none,
    });
    expect(page.items.map((i) => i.recipient_id)).toEqual(['a', 'b']);
    expect(page.next_cursor).not.toBeNull();
    const inCall = calls.find((c) => c.method === 'in' && c.args[0] === 'status');
    expect(inCall?.args[1]).toEqual(['entregue', 'lido']);
    expect(calls.some((c) => c.method === 'not' && c.args[0] === 'replied_at')).toBe(true);
  });

  it('filtro de telefone: pré-filtro por sufixo e igualdade exata por phoneKey (9º dígito tolerado)', async () => {
    const { db } = recorder({
      contacts: [],
      disp_message_queue: [item('a', { mensagem_final: '552199998888' }), item('b', { mensagem_final: '5521988887777' })],
    });
    const page = await loadRecipientPage(db, {
      accountId: 'ACC', campaignId: 'camp', filters: parseRecipientFilters(q('phone=5521999998888')), cursor: null, limit: 10, conversationsFor: none,
    });
    expect(page.items.map((i) => i.recipient_id)).toEqual(['a']);
  });

  it('modo funil: lista pelo utmpay_links e busca as linhas da fila da página', async () => {
    const { db, calls } = recorder({
      utmpay_links: [{ tid: 'b', created_at: '2026-10-07T14:00:00Z' }],
      disp_message_queue: [item('b', { status: 'entregue' })],
    });
    const page = await loadRecipientPage(db, {
      accountId: 'ACC', campaignId: 'camp', filters: parseRecipientFilters(q('paid=true')), cursor: null, limit: 5, conversationsFor: none,
    });
    expect(page.items.map((i) => i.recipient_id)).toEqual(['b']);
    expect(page.next_cursor).toBeNull();
    expect(calls.some((c) => c.table === 'utmpay_links' && c.method === 'not' && c.args[0] === 'pagou_em')).toBe(true);
  });
});
