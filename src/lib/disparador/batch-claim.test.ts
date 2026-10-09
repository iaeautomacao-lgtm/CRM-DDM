import { describe, expect, it, vi } from 'vitest';
import { ConfirmBatcher, registerShutdownDrain, singleConfirm, type ConfirmArgs } from './confirm-batcher';
import { ChannelClaimer, isBatchClaimEnabled, isClaimToken, makeClaimToken, planClaimTokens } from './batch-claim';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('flag e fichas', () => {
  it('DESLIGADO por padrão; só DISPARADOR_BATCH_CLAIM=1/true/on liga o claim em lote', () => {
    expect(isBatchClaimEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'ON', ' on ']) expect(isBatchClaimEnabled({ DISPARADOR_BATCH_CLAIM: v })).toBe(true);
    for (const v of ['0', 'false', 'OFF', ' off ']) expect(isBatchClaimEnabled({ DISPARADOR_BATCH_CLAIM: v })).toBe(false);
    expect(isBatchClaimEnabled({ DISPARADOR_BATCH_CLAIM: '1' })).toBe(true);
  });

  it('planClaimTokens: uma ficha por item vencido, agrupadas por número; null sem a RPC ou com resposta estranha', async () => {
    const db = {
      rpc: vi.fn(async () => ({
        data: [
          { campaign_id: 'c1', session_id: 's1', n: 3 },
          { campaign_id: 'c1', session_id: 's2', n: 2 },
          { campaign_id: 'c1', session_id: null, n: 9 }, // sem número: não é reivindicável
        ],
        error: null,
      })),
    };
    const plan = await planClaimTokens(db as never, 'c1', 100, '2026-01-01T00:00:00Z');
    expect(plan?.tokens).toHaveLength(5);
    expect(plan?.tokens.every(isClaimToken)).toBe(true);
    expect(plan?.tokens.filter((t) => t.session_id === 's1')).toHaveLength(3);
    expect(db.rpc).toHaveBeenCalledWith('count_due_dispatch_items', { p_campaign_ids: ['c1'], p_limit: 100 });

    const missing = { rpc: vi.fn(async () => ({ data: null, error: { code: 'PGRST202', message: 'x' } })) };
    expect(await planClaimTokens(missing as never, 'c1', 10)).toBeNull();
    const weird = { rpc: vi.fn(async () => ({ data: true, error: null })) };
    expect(await planClaimTokens(weird as never, 'c1', 10)).toBeNull();
    const broken = { rpc: vi.fn(async () => ({ data: null, error: { code: '57014', message: 'timeout' } })) };
    await expect(planClaimTokens(broken as never, 'c1', 10)).rejects.toThrow('timeout');
    expect(isClaimToken(makeClaimToken('c', 's', 0, 'x'))).toBe(true);
    expect(isClaimToken({ id: 'a1b2' })).toBe(false);
  });
});

describe('ChannelClaimer', () => {
  const rows = (ids: string[]) => ids.map((id) => ({ item: { id, campaign_id: 'c1', session_id: 's1' } }));

  it('vários next concorrentes do mesmo número esperam UM claim (single-flight) e recebem itens distintos', async () => {
    const db = { rpc: vi.fn(async () => (await sleep(5), { data: rows(['a', 'b', 'c', 'd']), error: null })) };
    const claimer = new ChannelClaimer({ db: db as never, defaultMaxInFlight: () => 100 });
    const got = await Promise.all([1, 2, 3, 4].map(() => claimer.next('s1', 'c1', 4)));
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith('claim_dispatch_batch', { p_session_id: 's1', p_n: 4, p_campaign_ids: ['c1'], p_default_max_in_flight: 100 });
    expect(got.map((g) => g?.item.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(claimer.stats()).toEqual({ claimed: 4, batches: 1 });
  });

  it('lote limitado às vagas livres e ao máximo (50)', async () => {
    const db = { rpc: vi.fn(async () => ({ data: rows(['a']), error: null })) };
    const claimer = new ChannelClaimer({ db: db as never, defaultMaxInFlight: () => undefined });
    await claimer.next('s1', 'c1', 999);
    expect((db.rpc.mock.calls[0] as unknown as [string, { p_n: number; p_default_max_in_flight: unknown }])[1]).toMatchObject({ p_n: 50, p_default_max_in_flight: null });
  });

  it('claim vazio esgota o par no tick: as fichas seguintes viram no-op sem nova RPC', async () => {
    const db = { rpc: vi.fn(async () => ({ data: [], error: null })) };
    const claimer = new ChannelClaimer({ db: db as never, defaultMaxInFlight: () => 4 });
    expect(await claimer.next('s1', 'c1', 4)).toBeNull();
    expect(await claimer.next('s1', 'c1', 4)).toBeNull();
    expect(await claimer.next('s1', 'c1', 4)).toBeNull();
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });

  it('esgotamento é por número×campanha: outro número ainda reivindica', async () => {
    const db = {
      rpc: vi.fn(async (_n: string, args: { p_session_id: string }) => ({ data: args.p_session_id === 's2' ? rows(['x']) : [], error: null })),
    };
    const claimer = new ChannelClaimer({ db: db as never, defaultMaxInFlight: () => 4 });
    expect(await claimer.next('s1', 'c1', 1)).toBeNull();
    expect((await claimer.next('s2', 'c1', 1))?.item.id).toBe('x');
  });

  it('sobra do buffer no fim do tick volta a agendado (unclaim) e a blacklist do lote acompanha os itens', async () => {
    const calls: Array<[string, unknown]> = [];
    const db = {
      rpc: vi.fn(async (name: string, args: unknown) => {
        calls.push([name, args]);
        return name === 'claim_dispatch_batch' ? { data: rows(['a', 'b', 'c']), error: null } : { data: 2, error: null };
      }),
    };
    const lookup = () => false;
    const preload = vi.fn(async () => lookup);
    const claimer = new ChannelClaimer({ db: db as never, defaultMaxInFlight: () => 4, preload });
    const first = await claimer.next('s1', 'c1', 3);
    expect(first?.item.id).toBe('a');
    expect(first?.blacklistLookup).toBe(lookup);
    expect(preload).toHaveBeenCalledTimes(1);
    expect(await claimer.releaseLeftovers()).toBe(2);
    expect(calls.at(-1)).toEqual(['unclaim_dispatch_items', { p_ids: ['b', 'c'] }]);
    expect(await claimer.releaseLeftovers()).toBe(0); // nada mais a devolver
  });

  it('falha na blacklist do lote não derruba o claim (cada envio consulta)', async () => {
    const db = { rpc: vi.fn(async () => ({ data: rows(['a']), error: null })) };
    const claimer = new ChannelClaimer({ db: db as never, defaultMaxInFlight: () => 4, preload: async () => { throw new Error('rpc'); } });
    const claimed = await claimer.next('s1', 'c1', 1);
    expect(claimed?.item.id).toBe('a');
    expect(claimed?.blacklistLookup).toBeUndefined();
  });

  it('erro do claim propaga (o cron registra e nada fica reservado)', async () => {
    const db = { rpc: vi.fn(async () => ({ data: null, error: { message: 'deadlock' } })) };
    const claimer = new ChannelClaimer({ db: db as never, defaultMaxInFlight: () => 4 });
    await expect(claimer.next('s1', 'c1', 1)).rejects.toThrow('deadlock');
  });
});

describe('ConfirmBatcher', () => {
  const args = (i: number): ConfirmArgs => ({
    p_item_id: `i${i}`, p_campaign_id: 'c', p_contact_id: null, p_session_id: 's', p_mensagem: 'm', p_waha_message_id: `w${i}`, p_tentativas: 1,
  });
  const okRpc = () =>
    vi.fn(async (_name: string, a: { p_items: ConfirmArgs[] }) => ({
      data: a.p_items.map((it, ord) => ({ ord: ord + 1, item_id: it.p_item_id, ok: true, error: null })),
      error: null,
    }));

  it('grava ao juntar 20 itens (sem esperar o relógio) numa única RPC', async () => {
    const rpc = okRpc();
    const batcher = new ConfirmBatcher({ db: { rpc } as never, single: vi.fn(), maxItems: 20, maxWaitMs: 10_000 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => batcher.submit(args(i))));
    expect(rpc).toHaveBeenCalledTimes(1);
    expect((rpc.mock.calls[0] as unknown as [string, { p_items: unknown[] }])[1].p_items).toHaveLength(20);
    expect(results.every((r) => r.error === null && r.replayed)).toBe(true);
    expect(batcher.confirmed).toBe(20);
  });

  it('grava um lote incompleto pelo relógio (janela ≤ ~150 ms)', async () => {
    const rpc = okRpc();
    const batcher = new ConfirmBatcher({ db: { rpc } as never, single: vi.fn(), maxItems: 20, maxWaitMs: 30 });
    const started = Date.now();
    const a = await batcher.submit(args(1));
    expect(a.error).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('erro de UM item volta só para ele; os outros confirmam', async () => {
    const rpc = vi.fn(async () => ({
      data: [{ ok: true }, { ok: false, error: 'Queue item identity mismatch' }, { ok: true }],
      error: null,
    }));
    const batcher = new ConfirmBatcher({ db: { rpc } as never, single: vi.fn(), maxItems: 3, maxWaitMs: 1000 });
    const out = await Promise.all([batcher.submit(args(0)), batcher.submit(args(1)), batcher.submit(args(2))]);
    expect(out.map((r) => r.error?.message ?? null)).toEqual([null, 'Queue item identity mismatch', null]);
  });

  it('falha do lote inteiro devolve o erro a todos (o processQueue guarda o recibo; nada é reenviado)', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { message: 'timeout', code: '57014' } }));
    const batcher = new ConfirmBatcher({ db: { rpc } as never, single: vi.fn(), maxItems: 2, maxWaitMs: 1000 });
    const out = await Promise.all([batcher.submit(args(0)), batcher.submit(args(1))]);
    expect(out.map((r) => r.error?.message)).toEqual(['timeout', 'timeout']);
  });

  it('sem a RPC do lote cai na confirmação unitária (e lembra)', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: 'PGRST202', message: 'not found' } }));
    const single = vi.fn(async () => ({ error: null, replayed: false }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const batcher = new ConfirmBatcher({ db: { rpc } as never, single, maxItems: 2, maxWaitMs: 1000 });
    await Promise.all([batcher.submit(args(0)), batcher.submit(args(1))]);
    expect(single).toHaveBeenCalledTimes(2);
    await Promise.all([batcher.submit(args(2)), batcher.submit(args(3))]);
    expect(rpc).toHaveBeenCalledTimes(1); // não tenta o lote de novo
    expect(single).toHaveBeenCalledTimes(4);
  });

  it('drain grava o pendente e espera os lotes em andamento (fim do tick / SIGTERM)', async () => {
    const rpc = vi.fn(async (_n: string, a: { p_items: ConfirmArgs[] }) => (await sleep(20), { data: a.p_items.map(() => ({ ok: true })), error: null }));
    const batcher = new ConfirmBatcher({ db: { rpc } as never, single: vi.fn(), maxItems: 100, maxWaitMs: 60_000 });
    const pending = [batcher.submit(args(0)), batcher.submit(args(1))];
    await batcher.drain();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect((await Promise.all(pending)).every((r) => r.error === null)).toBe(true);
  });

  it('SIGTERM drena os batchers ativos; depois de cancelar o registro, não', async () => {
    const rpc = okRpc();
    const batcher = new ConfirmBatcher({ db: { rpc } as never, single: vi.fn(), maxItems: 100, maxWaitMs: 60_000 });
    const unregister = registerShutdownDrain(batcher);
    const pending = batcher.submit(args(0));
    // D-02: o SIGTERM agora primeiro espera os envios em voo (nenhum aqui) e só então drena.
    process.emit('SIGTERM');
    expect((await pending).error).toBeNull();
    expect(rpc).toHaveBeenCalledTimes(1);
    unregister();
  });

  it('singleConfirm: usa confirm_dispatch_item_sent e cai no mark_queue_item_sent sem a 167', async () => {
    const calls: string[] = [];
    const db = {
      rpc: vi.fn(async (name: string) => {
        calls.push(name);
        return name === 'confirm_dispatch_item_sent' ? { error: { code: '42883', message: 'x' } } : { error: null };
      }),
    };
    const single = singleConfirm(db as never);
    expect(await single({})).toEqual({ error: null, replayed: false });
    await single({});
    expect(calls).toEqual(['confirm_dispatch_item_sent', 'mark_queue_item_sent', 'mark_queue_item_sent']);
  });
});
