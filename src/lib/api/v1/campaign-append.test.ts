import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  red: vi.fn(async (..._a: unknown[]) => [] as unknown[]),
  approved: vi.fn(async (..._a: unknown[]) => true),
  blacklist: new Set<string>(),
}));
vi.mock('@/lib/disparador/red-quality-gate', () => ({ findRedChannels: hoisted.red, RED_QUALITY_CODE: 'red_quality_owner_required', redBlockedMessage: () => 'Número com qualidade vermelha' }));
vi.mock('@/lib/disparador/template-pause', async (orig) => ({ ...(await orig<typeof import('@/lib/disparador/template-pause')>()), allTemplatesApproved: hoisted.approved }));
vi.mock('@/lib/disparador/blacklist-keys', () => ({ loadBlacklistKeySet: vi.fn(async () => hoisted.blacklist) }));

import { appendRecipients, APPEND_BLOCK, buildAppendRows } from './campaign-append';
import { phoneKey } from '@/lib/disparador/phone-key';

type Tables = Record<string, any[]>;
let tables: Tables;
let rpcCalls: Array<{ fn: string; args: any }>;
let rpcImpl: (args: any, n: number) => { data: unknown; error: unknown };
let missingSlotColumns = false;

function makeDb() {
  return {
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = [];
      let cols = '';
      const chain: any = {};
      for (const m of ['order', 'limit', 'in']) chain[m] = () => chain;
      chain.select = (c: string) => ((cols = c), chain);
      chain.eq = (c: string, v: unknown) => (eqs.push([c, v]), chain);
      chain.then = (resolve: (v: unknown) => void) => {
        if (table === 'campaigns' && missingSlotColumns && cols.includes('slot_size')) return resolve({ data: null, error: { code: '42703', message: 'column "slot_size" does not exist' } });
        resolve({ data: (tables[table] ?? []).filter((r) => eqs.every(([c, v]) => r[c] === v)), error: null });
      };
      return chain;
    },
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      return rpcImpl(args, rpcCalls.length);
    },
  } as never;
}

const metaCampaign = (over: Record<string, unknown> = {}) => ({
  id: 'C1', account_id: 'ACC', status: 'em_execucao', source: 'api_v1', session_ids: ['S1'], janela_inicio: '08:00:00', janela_fim: '18:00:00', dias_envio: [1, 2, 3, 4, 5, 6, 0],
  mensagens: [{ tipo: 'texto', conteudo: '[Template: promo]', template_name: 'promo', template_language: 'pt_BR' }], slot_size: 2, slot_interval_minutes: 10, ...over,
});
const contact = (n: number, extra: Record<string, unknown> = {}) => ({ phone: `55119${String(10_000_000 + n)}`, variables: ['Ana'], ...extra });
const NOW = new Date('2026-10-20T12:00:00Z');

beforeEach(() => {
  tables = {
    campaigns: [metaCampaign()],
    whatsapp_config: [{ id: 'S1', account_id: 'ACC', provider: 'meta' }],
    message_templates: [{ account_id: 'ACC', name: 'promo', status: 'APPROVED', body_text: 'Olá {{1}}' }],
    disp_message_queue: [],
  };
  rpcCalls = [];
  rpcImpl = (args) => ({ data: { added: args.p_rows.length, duplicates: 0, total: args.p_rows.length }, error: null });
  hoisted.red.mockResolvedValue([]);
  hoisted.approved.mockResolvedValue(true);
  hoisted.blacklist = new Set();
  missingSlotColumns = false;
});

describe('buildAppendRows', () => {
  const times = [new Date('2026-10-20T12:00:00Z'), new Date('2026-10-20T12:00:01Z')];
  it('Meta: parâmetros do template, telefone em mensagem_final, sem substituir {{n}} no código', () => {
    const rows = buildAppendRows([{ phone: '5521999998888', variables: ['Ana'], reference: 'c-1' }, { phone: '5521977776666', variables: ['Bia'], reference: null }], times, {
      provider: 'meta', channelId: 'S1', message: { template_name: 'promo', template_language: 'pt_BR' },
    }) as any[];
    expect(rows[0]).toMatchObject({ session_id: 'S1', mensagem_final: '5521999998888', tipo: 'texto', template_name: 'promo', template_language: 'pt_BR', template_variables: ['Ana'], reference: 'c-1' });
    expect('reference' in rows[1]).toBe(false);
  });
  it('WAHA: texto já resolvido em template_variables[0] com o marcador, mídia da campanha', () => {
    const rows = buildAppendRows([{ phone: '5521999998888', variables: ['Ana', 'R$ 10'], reference: null }], [times[0]], {
      provider: 'waha', channelId: 'S1', message: { tipo: 'imagem', conteudo: 'Oi {{1}}, deve {{2}}', url: 'chat-media://x.png' },
    }) as any[];
    expect(rows[0]).toMatchObject({ tipo: 'imagem', media_url: 'chat-media://x.png', template_variables: ['Oi Ana, deve R$ 10'], template_language: null });
    expect(rows[0].template_name).toMatch(/waha/i);
  });
});

describe('appendRecipients', () => {
  it('adiciona em blocos de 1.000 pela RPC, depois do último já agendado, com o ritmo da campanha', async () => {
    tables.disp_message_queue = [{ campaign_id: 'C1', scheduled_at: '2026-10-21T12:00:00Z' }];
    const contacts = Array.from({ length: 2500 }, (_, i) => contact(i));
    const r = await appendRecipients(makeDb(), { accountId: 'ACC', campaignId: 'C1', contacts, now: NOW });
    expect(rpcCalls.map((c) => c.args.p_rows.length)).toEqual([APPEND_BLOCK, APPEND_BLOCK, 500]);
    expect(rpcCalls[0].args).toMatchObject({ p_account: 'ACC', p_campaign: 'C1', p_cap: 50000 });
    const firstAt = Date.parse(rpcCalls[0].args.p_rows[0].scheduled_at);
    expect(firstAt).toBeGreaterThanOrEqual(Date.parse('2026-10-21T12:00:00Z'));
    expect(r).toMatchObject({ added: 2500, duplicates: 0, invalid: 0, skipped: 0 });
  });

  it('blacklist, duplicados no pedido, inválidos e duplicados contra a campanha entram na contagem', async () => {
    hoisted.blacklist = new Set([phoneKey('5511910000001')]);
    rpcImpl = (args) => ({ data: { added: args.p_rows.length - 1, duplicates: 1, total: 7 }, error: null });
    const contacts = [contact(1), contact(2), contact(2), { phone: '12', variables: ['x'] }, contact(3, { reference: 'r'.repeat(65) }), contact(4)];
    const r = await appendRecipients(makeDb(), { accountId: 'ACC', campaignId: 'C1', contacts, now: NOW });
    expect(r).toMatchObject({ skipped: 1, invalid: 2, total_contacts: 7 });
    expect(r.duplicates).toBe(2); // 1 repetido no pedido + 1 já na campanha
    expect(r.added).toBe(1);
    expect(r.invalid_sample.map((s) => s.reason).sort()).toEqual(['invalid_phone', 'invalid_reference']);
  });

  it('variável do template ausente invalida o contato; tudo inválido = 400 sem chamar a RPC', async () => {
    const r = appendRecipients(makeDb(), { accountId: 'ACC', campaignId: 'C1', contacts: [{ phone: '5511910000001', variables: [] }], now: NOW });
    await expect(r).rejects.toMatchObject({ status: 400 });
    expect(rpcCalls).toHaveLength(0);
  });

  it('campanha inexistente = 404; do painel = 409 not_api_campaign; encerrada/rascunho = 409 com o estado', async () => {
    await expect(appendRecipients(makeDb(), { accountId: 'OUTRA', campaignId: 'C1', contacts: [contact(1)] })).rejects.toMatchObject({ status: 404 });
    tables.campaigns = [metaCampaign({ source: 'dashboard' })];
    await expect(appendRecipients(makeDb(), { accountId: 'ACC', campaignId: 'C1', contacts: [contact(1)] })).rejects.toMatchObject({ status: 409, extra: { details: { code: 'not_api_campaign' } } });
    for (const status of ['encerrada', 'rascunho', 'preparando', 'agendado']) {
      tables.campaigns = [metaCampaign({ status })];
      await expect(appendRecipients(makeDb(), { accountId: 'ACC', campaignId: 'C1', contacts: [contact(1)] })).rejects.toMatchObject({ status: 409, extra: { details: { status } } });
    }
    expect(rpcCalls).toHaveLength(0);
  });

  it('número vermelho e template não aprovado bloqueiam (409); a API nunca confirma', async () => {
    hoisted.red.mockResolvedValue([{ id: 'S1', display_phone_number: '+55' }]);
    await expect(appendRecipients(makeDb(), { accountId: 'ACC', campaignId: 'C1', contacts: [contact(1)], now: NOW })).rejects.toMatchObject({ status: 409, extra: { details: { code: 'red_quality_owner_required' } } });
    hoisted.red.mockResolvedValue([]);
    hoisted.approved.mockResolvedValue(false);
    await expect(appendRecipients(makeDb(), { accountId: 'ACC', campaignId: 'C1', contacts: [contact(1)], now: NOW })).rejects.toMatchObject({ status: 409, extra: { details: { code: 'template_not_approved' } } });
    expect(rpcCalls).toHaveLength(0);
  });

  it('limites: mais de 20.000 na chamada = 413; RPC com cap = 413; mudança de estado no meio = 409 informando quantos entraram', async () => {
    await expect(appendRecipients(makeDb(), { accountId: 'ACC', campaignId: 'C1', contacts: new Array(20_001).fill(contact(1)) })).rejects.toMatchObject({ status: 413 });
    rpcImpl = () => ({ data: { error: 'cap', total: 49_900, cap: 50_000 }, error: null });
    await expect(appendRecipients(makeDb(), { accountId: 'ACC', campaignId: 'C1', contacts: [contact(1)], now: NOW })).rejects.toMatchObject({ status: 413, extra: { details: { total: 49_900, cap: 50_000 } } });
    rpcCalls = [];
    rpcImpl = (args, n) => (n === 1 ? { data: { added: args.p_rows.length, duplicates: 0, total: 1000 }, error: null } : { data: { error: 'status', status: 'encerrada' }, error: null });
    await expect(appendRecipients(makeDb(), { accountId: 'ACC', campaignId: 'C1', contacts: Array.from({ length: 1500 }, (_, i) => contact(i)), now: NOW })).rejects.toMatchObject({ status: 409, extra: { details: { status: 'encerrada', added_before_error: 1000 } } });
  });

  it('sem a migration 358 = 503; RPC devolvendo NULL = 404; sem as colunas da 357 usa o ritmo padrão', async () => {
    rpcImpl = () => ({ data: null, error: { code: '42883', message: 'function wacrm.add_campaign_recipients does not exist' } });
    await expect(appendRecipients(makeDb(), { accountId: 'ACC', campaignId: 'C1', contacts: [contact(1)], now: NOW })).rejects.toMatchObject({ status: 503, code: 'unavailable' });
    rpcImpl = () => ({ data: null, error: null });
    await expect(appendRecipients(makeDb(), { accountId: 'ACC', campaignId: 'C1', contacts: [contact(1)], now: NOW })).rejects.toMatchObject({ status: 404 });
    rpcImpl = (args) => ({ data: { added: args.p_rows.length, duplicates: 0, total: 1 }, error: null });
    missingSlotColumns = true;
    expect((await appendRecipients(makeDb(), { accountId: 'ACC', campaignId: 'C1', contacts: [contact(1)], now: NOW })).added).toBe(1);
  });
});
