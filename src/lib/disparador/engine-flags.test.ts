import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildEngineFlagsView,
  clearEngineFlagCache,
  envWithEngineFlags,
  EngineFlagsError,
  loadEngineFlagRows,
  parseEngineFlagsPatch,
  resolveEngineFlag,
  saveEngineFlags,
  type EngineFlagRow,
} from './engine-flags';
import { isBatchClaimEnabled } from './batch-claim';
import { resolveTickChainConfig } from './tick-chain';
import { resolveThroughputConfig } from './throughput-config';

const row = (account_id: string, batch_claim: boolean | null, tick_chain: boolean | null): EngineFlagRow => ({ account_id, batch_claim, tick_chain });

describe('resolveEngineFlag', () => {
  it('sem linhas segue o ambiente; sem ambiente é desligado (como hoje)', () => {
    expect(resolveEngineFlag('batch_claim', [], {})).toEqual({ enabled: false, source: 'default' });
    expect(resolveEngineFlag('batch_claim', [], { DISPARADOR_BATCH_CLAIM: '1' })).toEqual({ enabled: true, source: 'env' });
    expect(resolveEngineFlag('tick_chain', [], { DISPARADOR_TICK_CHAIN: '0' })).toEqual({ enabled: false, source: 'env' });
  });
  it('NULL na conta = segue o ambiente', () => {
    expect(resolveEngineFlag('tick_chain', [row('A', null, null)], { DISPARADOR_TICK_CHAIN: '1' })).toEqual({ enabled: true, source: 'env' });
  });
  it('a conta vence o ambiente nos dois sentidos', () => {
    expect(resolveEngineFlag('batch_claim', [row('A', true, null)], {})).toEqual({ enabled: true, source: 'account' });
    expect(resolveEngineFlag('batch_claim', [row('A', false, null)], { DISPARADOR_BATCH_CLAIM: '1' })).toEqual({ enabled: false, source: 'account' });
  });
  it('várias contas: ligar de qualquer uma liga; senão desligar de qualquer uma desliga', () => {
    expect(resolveEngineFlag('tick_chain', [row('A', null, false), row('B', null, true)], {}).enabled).toBe(true);
    expect(resolveEngineFlag('tick_chain', [row('A', null, false), row('B', null, null)], { DISPARADOR_TICK_CHAIN: '1' })).toEqual({ enabled: false, source: 'account' });
  });
});

describe('envWithEngineFlags: os resolvedores existentes passam a enxergar a decisão da conta', () => {
  it('liga o lote e o encadeamento (e o orçamento do tick sobe para 50 s) sem variável de ambiente', () => {
    const env = envWithEngineFlags({}, [row('A', true, true)]);
    expect(isBatchClaimEnabled(env)).toBe(true);
    expect(resolveTickChainConfig({ ...env, NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:3000' }).enabled).toBe(true);
    expect(resolveThroughputConfig(env).tickBudgetMs).toBe(50_000);
  });
  it('desliga o que o ambiente ligou; NULL não mexe no ambiente', () => {
    const off = envWithEngineFlags({ DISPARADOR_BATCH_CLAIM: '1', DISPARADOR_TICK_CHAIN: '1' }, [row('A', false, null)]);
    expect(isBatchClaimEnabled(off)).toBe(false);
    expect(off.DISPARADOR_TICK_CHAIN).toBe('1');
    const same = { DISPARADOR_BATCH_CLAIM: '1' };
    expect(envWithEngineFlags(same, [row('A', null, null)])).toEqual(same);
  });
  it('não altera o objeto original', () => {
    const env = { DISPARADOR_TICK_CHAIN: '0' };
    envWithEngineFlags(env, [row('A', null, true)]);
    expect(env).toEqual({ DISPARADOR_TICK_CHAIN: '0' });
  });
});

describe('buildEngineFlagsView', () => {
  it('mostra o valor da conta, o efetivo com a origem e o do ambiente', () => {
    const view = buildEngineFlagsView('A', [row('A', true, null), row('B', null, true)], { DISPARADOR_TICK_CHAIN: '0' });
    expect(view.account).toEqual({ batch_claim: true, tick_chain: null });
    expect(view.effective.batch_claim).toEqual({ enabled: true, source: 'account' });
    expect(view.effective.tick_chain).toEqual({ enabled: true, source: 'account' }); // a conta B liga
    expect(view.env).toEqual({ batch_claim: false, tick_chain: false });
    expect(buildEngineFlagsView('C', [], {}).account).toEqual({ batch_claim: null, tick_chain: null });
  });
});

function dbWith(result: { data?: unknown; error?: { code?: string; message: string } | null }, onUpsert?: (row: unknown) => void) {
  const calls = { selects: 0 };
  const chain: any = {};
  for (const m of ['select', 'eq', 'limit']) chain[m] = () => ((calls.selects += m === 'select' ? 1 : 0), chain);
  chain.upsert = (payload: unknown) => {
    onUpsert?.(payload);
    return Promise.resolve({ error: null });
  };
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: result.data ?? [], error: result.error ?? null });
  return { db: { from: () => chain } as never, calls };
}

describe('loadEngineFlagRows', () => {
  beforeEach(() => clearEngineFlagCache());
  it('cacheia por 10 s e relê depois', async () => {
    const { db, calls } = dbWith({ data: [row('A', true, null)] });
    expect(await loadEngineFlagRows(db, { now: 1_000 })).toHaveLength(1);
    await loadEngineFlagRows(db, { now: 5_000 });
    expect(calls.selects).toBe(1);
    await loadEngineFlagRows(db, { now: 12_000 });
    expect(calls.selects).toBe(2);
    await loadEngineFlagRows(db, { now: 12_001, ttlMs: 0 });
    expect(calls.selects).toBe(3);
  });
  it('sem a tabela (migration 366 pendente) ou com erro: [] e segue o ambiente, sem lançar', async () => {
    expect(await loadEngineFlagRows(dbWith({ error: { code: '42P01', message: 'relation does not exist' } }).db, { ttlMs: 0 })).toEqual([]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await loadEngineFlagRows(dbWith({ error: { code: 'XX', message: 'boom' } }).db, { ttlMs: 0 })).toEqual([]);
  });
});

describe('parseEngineFlagsPatch e saveEngineFlags', () => {
  it('aceita boolean ou null, exige ao menos uma chave e recusa o resto', () => {
    expect(parseEngineFlagsPatch({ batch_claim: true })).toEqual({ batch_claim: true });
    expect(parseEngineFlagsPatch({ tick_chain: null, batch_claim: false })).toEqual({ tick_chain: null, batch_claim: false });
    expect(() => parseEngineFlagsPatch({})).toThrow(EngineFlagsError);
    expect(() => parseEngineFlagsPatch({ batch_claim: 'sim' })).toThrow(/true, false ou null/);
    expect(() => parseEngineFlagsPatch(null)).toThrow(EngineFlagsError);
    expect(() => parseEngineFlagsPatch([true])).toThrow(EngineFlagsError);
  });
  it('mescla com o que já está gravado, grava o autor e invalida o cache', async () => {
    let saved: any;
    const { db } = dbWith({ data: [row('A', true, null)] }, (p) => (saved = p));
    const next = await saveEngineFlags(db, { accountId: 'A', userId: 'U1', patch: { tick_chain: true } });
    expect(next).toEqual(row('A', true, true));
    expect(saved).toMatchObject({ account_id: 'A', batch_claim: true, tick_chain: true, updated_by: 'U1' });
  });
  it('sem a migration 366 = 503 com mensagem clara', async () => {
    const { db } = dbWith({ error: { code: '42P01', message: 'relation "wacrm.dispatch_engine_flags" does not exist' } });
    await expect(saveEngineFlags(db, { accountId: 'A', userId: null, patch: { batch_claim: true } })).rejects.toMatchObject({ status: 503 });
  });
});
