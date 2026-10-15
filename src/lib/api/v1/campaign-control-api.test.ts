import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/rate-limit', async (orig) => ({ ...(await orig<typeof import('@/lib/rate-limit')>()), checkRateLimit: vi.fn(async () => ({ success: true, remaining: 1, reset: 0, limit: 30 })) }));

import {
  combineStatuses,
  controlFailureToApiError,
  parseCancelBody,
  parsePauseBody,
  parseRemoveBody,
  parseResumeBody,
  phoneKeysForCpfs,
  readOptionalJsonObject,
  removeRecipients,
} from './campaign-control-api';
import { phoneKey } from '@/lib/disparador/phone-key';

const json = (body: unknown) => new Request('http://x', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('corpos das ações', () => {
  it('corpo vazio é válido; JSON inválido e não-objeto são 400', async () => {
    expect(await readOptionalJsonObject(json(''))).toEqual({});
    await expect(readOptionalJsonObject(json('{x'))).rejects.toMatchObject({ status: 400 });
    await expect(readOptionalJsonObject(json('[1]'))).rejects.toMatchObject({ status: 400 });
  });
  it('pause: reason opcional até 200 caracteres', () => {
    expect(parsePauseBody({})).toEqual({ reason: null });
    expect(parsePauseBody({ reason: ' ok ' })).toEqual({ reason: 'ok' });
    expect(() => parsePauseBody({ reason: 'x'.repeat(201) })).toThrow(/200/);
    expect(() => parsePauseBody({ reason: 5 })).toThrow(/200/);
  });
  it('resume: acknowledge_auto_pause só booleano', () => {
    expect(parseResumeBody({})).toEqual({ acknowledgeAutoPause: false });
    expect(parseResumeBody({ acknowledge_auto_pause: true })).toEqual({ acknowledgeAutoPause: true });
    expect(() => parseResumeBody({ acknowledge_auto_pause: 'sim' })).toThrow(/true ou false/);
  });
  it('cancel exige confirm: true', () => {
    expect(() => parseCancelBody({})).toThrow(/irreversível/);
    expect(() => parseCancelBody({ confirm: 'true' })).toThrow(/irreversível/);
    expect(() => parseCancelBody({ confirm: true })).not.toThrow();
  });
  it('falhas de negócio viram o envelope certo: 404, 409 com details, 500', () => {
    expect(controlFailureToApiError({ ok: false, kind: 'not_found', message: 'x' })).toMatchObject({ status: 404, code: 'not_found' });
    const c = controlFailureToApiError({ ok: false, kind: 'conflict', message: 'x', details: { status: 'encerrada' } });
    expect(c).toMatchObject({ status: 409, code: 'conflict', extra: { details: { status: 'encerrada' } } });
    expect(controlFailureToApiError({ ok: false, kind: 'blocked', message: 'x', details: { code: 'red_quality' } })).toMatchObject({ status: 409, extra: { details: { code: 'red_quality' } } });
    expect(controlFailureToApiError({ ok: false, kind: 'internal', message: 'x' })).toMatchObject({ status: 500, code: 'internal' });
  });
});

describe('parseRemoveBody', () => {
  it('exige lista de 1 a 500 e motivo válido (padrão other)', () => {
    expect(() => parseRemoveBody({})).toThrow(/obrigatório/);
    expect(() => parseRemoveBody({ recipients: [] })).toThrow(/obrigatório/);
    expect(() => parseRemoveBody({ recipients: Array.from({ length: 501 }, () => ({ phone: '5521999998888' })) })).toThrow(/500/);
    expect(() => parseRemoveBody({ recipients: [{ phone: '5521999998888' }], reason: 'pago' })).toThrow(/reason/);
    expect(parseRemoveBody({ recipients: [{ phone: '5521999998888' }] }).reason).toBe('other');
  });
  it('cada item vira chave de telefone / CPF só dígitos / referência; inválido não derruba os demais', () => {
    const p = parseRemoveBody({
      recipients: [{ phone: '+55 21 99999-8888' }, { cpf: '529.982.247-25' }, { reference: ' contrato-1 ' }, { phone: '12' }, { cpf: '111.111.111-11' }, {}, 'x', { reference: 'r'.repeat(65) }],
    });
    expect(p.entries[0]).toMatchObject({ phoneKey: phoneKey('5521999998888'), invalid: null });
    expect(p.entries[1]).toMatchObject({ cpf: '52998224725', invalid: null });
    expect(p.entries[2]).toMatchObject({ reference: 'contrato-1', invalid: null });
    expect(p.entries.slice(3).every((e) => !!e.invalid)).toBe(true);
    expect(p.entries[5].invalid).toMatch(/phone.*cpf.*reference/);
  });
});

describe('combineStatuses', () => {
  it('vence a maior prioridade e soma os itens', () => {
    expect(combineStatuses([])).toEqual({ status: 'not_found', items: 0 });
    expect(combineStatuses([{ status: 'not_found', items: 0 }, { status: 'already_sent', items: 2 }])).toEqual({ status: 'already_sent', items: 2 });
    expect(combineStatuses([{ status: 'already_sent', items: 1 }, { status: 'removed', items: 1 }, { status: 'in_flight', items: 1 }])).toEqual({ status: 'removed', items: 3 });
    expect(combineStatuses([{ status: 'already_removed', items: 1 }, { status: 'in_flight', items: 1 }]).status).toBe('in_flight');
  });
});

function fakeDb(opts: { contacts?: unknown[]; phones?: unknown[]; campaign?: boolean; rpc?: (args: Record<string, unknown>) => { data: unknown; error: unknown } }) {
  const rpcCalls: Array<Record<string, unknown>> = [];
  const db = {
    from: (table: string) => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'in', 'limit']) chain[m] = () => chain;
      chain.then = (resolve: (v: unknown) => void) => {
        if (table === 'contacts') return resolve({ data: opts.contacts ?? [], error: null });
        if (table === 'contact_phones') return resolve({ data: opts.phones ?? [], error: null });
        return resolve({ data: opts.campaign === false ? [] : [{ id: 'CAMP' }], error: null });
      };
      return chain;
    },
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      rpcCalls.push(args);
      return opts.rpc ? opts.rpc(args) : { data: { removed: 0, phones: {}, references: {} }, error: null };
    },
  } as never;
  return { db, rpcCalls };
}

describe('phoneKeysForCpfs', () => {
  it('junta o telefone principal e os alternativos do contato com aquele CPF', async () => {
    const { db } = fakeDb({
      contacts: [{ id: 'c1', phone: '+5521988887777', cpf: '52998224725' }],
      phones: [{ contact_id: 'c1', phone: '5521933332222' }],
    });
    const map = await phoneKeysForCpfs(db, 'ACC', ['52998224725', '52998224725']);
    expect(map.get('52998224725')).toEqual([phoneKey('+5521988887777'), phoneKey('5521933332222')]);
  });
});

describe('removeRecipients', () => {
  const parsed = () =>
    parseRemoveBody({ reason: 'paid', recipients: [{ phone: '5521999998888' }, { cpf: '529.982.247-25' }, { reference: 'contrato-1' }, { cpf: '390.533.447-05' }, { phone: '12' }] });

  it('monta chamada única à RPC (telefones + telefones do CPF + referências) e devolve resultado por item, na ordem', async () => {
    const k1 = phoneKey('5521999998888');
    const k2 = phoneKey('+5521988887777');
    const { db, rpcCalls } = fakeDb({
      contacts: [{ id: 'c1', phone: '+5521988887777', cpf: '52998224725' }],
      rpc: () => ({
        data: {
          removed: 2,
          phones: { [k1]: { status: 'removed', items: 1 }, [k2]: { status: 'already_sent', items: 1 } },
          references: { 'contrato-1': { status: 'removed', items: 1 } },
        },
        error: null,
      }),
    });
    const r = await removeRecipients(db, { accountId: 'ACC', campaignId: 'CAMP', parsed: parsed() });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toMatchObject({ p_account: 'ACC', p_campaign: 'CAMP', p_reason: 'paid', p_references: ['contrato-1'] });
    expect((rpcCalls[0].p_phone_keys as string[]).sort()).toEqual([k1, k2].sort());
    expect(r!.results.map((x) => x.status)).toEqual(['removed', 'already_sent', 'removed', 'not_found', 'invalid']);
    expect(r).toMatchObject({ items_removed: 2, removed: 2, already_sent: 1, not_found: 1, invalid: 1 });
    expect(JSON.stringify(r)).not.toMatch(/52998224725|529\.982/);
  });

  it('campanha de outra conta (RPC devolve NULL) = null → a rota responde 404', async () => {
    const { db } = fakeDb({ rpc: () => ({ data: null, error: null }) });
    expect(await removeRecipients(db, { accountId: 'ACC', campaignId: 'CAMP', parsed: parseRemoveBody({ recipients: [{ phone: '5521999998888' }] }) })).toBeNull();
  });

  it('só CPF sem contato e entradas inválidas: não chama a RPC, mas confere que a campanha é da conta', async () => {
    const only = parseRemoveBody({ recipients: [{ cpf: '529.982.247-25' }, { phone: '1' }] });
    const ok = fakeDb({});
    const r = await removeRecipients(ok.db, { accountId: 'ACC', campaignId: 'CAMP', parsed: only });
    expect(ok.rpcCalls).toHaveLength(0);
    expect(r!.results.map((x) => x.status)).toEqual(['not_found', 'invalid']);
    expect(await removeRecipients(fakeDb({ campaign: false }).db, { accountId: 'ACC', campaignId: 'CAMP', parsed: only })).toBeNull();
  });

  it('sem a RPC (migration 357 pendente) = 503 unavailable', async () => {
    const { db } = fakeDb({ rpc: () => ({ data: null, error: { code: '42883', message: 'function wacrm.remove_campaign_recipients does not exist' } }) });
    await expect(removeRecipients(db, { accountId: 'ACC', campaignId: 'CAMP', parsed: parseRemoveBody({ recipients: [{ phone: '5521999998888' }] }) })).rejects.toMatchObject({ status: 503, code: 'unavailable' });
  });
});
