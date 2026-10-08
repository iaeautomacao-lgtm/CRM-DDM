import { describe, expect, it, vi } from 'vitest';
import {
  CHAIN_HOP_HEADER,
  CHAIN_START_HEADER,
  fireNextHop,
  isMaintenanceHop,
  isTickChainEnabled,
  readChainContext,
  resolveTickChainConfig,
  shouldChainNext,
} from './tick-chain';
import { resolveThroughputConfig } from './throughput-config';

const headers = (h: Record<string, string>) => new Headers(h);
const NOW = 1_800_000_000_000;

describe('configuração do tick encadeado', () => {
  it('desligado por padrão; liga com 1/true/on', () => {
    expect(isTickChainEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'ON', ' True ']) expect(isTickChainEnabled({ DISPARADOR_TICK_CHAIN: v })).toBe(true);
    expect(isTickChainEnabled({ DISPARADOR_TICK_CHAIN: '0' })).toBe(false);
  });

  it('limites com clamp e origem do próprio cron (DISPARADOR_CHAIN_URL vence NEXT_PUBLIC_APP_URL)', () => {
    const cfg = resolveTickChainConfig({
      DISPARADOR_TICK_CHAIN: '1',
      DISPARADOR_TICK_CHAIN_MAX_PER_MIN: '999',
      DISPARADOR_TICK_CHAIN_MAX_HOPS: '0',
      DISPARADOR_TICK_CHAIN_MAINTENANCE_EVERY: 'abc',
      DISPARADOR_CHAIN_URL: 'http://127.0.0.1:3000/qualquer/caminho',
      NEXT_PUBLIC_APP_URL: 'https://crm.exemplo.com',
    });
    expect(cfg).toEqual({ enabled: true, maxHopsPerMinute: 60, maxHops: 1, maintenanceEvery: 5, baseUrl: 'http://127.0.0.1:3000' });
    expect(resolveTickChainConfig({ NEXT_PUBLIC_APP_URL: 'https://crm.exemplo.com/' }).baseUrl).toBe('https://crm.exemplo.com');
    expect(resolveTickChainConfig({ DISPARADOR_CHAIN_URL: 'ftp://x', NEXT_PUBLIC_APP_URL: 'http://u:p@x' }).baseUrl).toBeNull();
    expect(resolveTickChainConfig({}).baseUrl).toBeNull();
  });

  it('com o encadeamento ligado o orçamento do tick sobe para 50 s (a não ser que o env defina)', () => {
    expect(resolveThroughputConfig({}).tickBudgetMs).toBe(35_000);
    expect(resolveThroughputConfig({ DISPARADOR_TICK_CHAIN: '1' }).tickBudgetMs).toBe(50_000);
    expect(resolveThroughputConfig({ DISPARADOR_TICK_CHAIN: '1', DISPARADOR_TICK_BUDGET_MS: '20000' }).tickBudgetMs).toBe(20_000);
  });
});

describe('contexto do hop', () => {
  it('sem headers: início de cadeia (hop 0)', () => {
    expect(readChainContext(headers({}), NOW)).toEqual({ hop: 0, startedAtMs: NOW, chained: false });
  });
  it('lê hop e início válidos', () => {
    const ctx = readChainContext(headers({ [CHAIN_HOP_HEADER]: '3', [CHAIN_START_HEADER]: String(NOW - 60_000) }), NOW);
    expect(ctx).toEqual({ hop: 3, startedAtMs: NOW - 60_000, chained: true });
  });
  it('valores inválidos, futuros ou velhos demais viram início de cadeia', () => {
    for (const h of [
      { [CHAIN_HOP_HEADER]: 'x', [CHAIN_START_HEADER]: String(NOW) },
      { [CHAIN_HOP_HEADER]: '2', [CHAIN_START_HEADER]: 'abc' },
      { [CHAIN_HOP_HEADER]: '2', [CHAIN_START_HEADER]: String(NOW + 3_600_000) },
      { [CHAIN_HOP_HEADER]: '2', [CHAIN_START_HEADER]: String(NOW - 2 * 3_600_000) },
      { [CHAIN_HOP_HEADER]: '99999', [CHAIN_START_HEADER]: String(NOW) },
      { [CHAIN_HOP_HEADER]: '-1', [CHAIN_START_HEADER]: String(NOW) },
    ]) {
      expect(readChainContext(headers(h), NOW)).toEqual({ hop: 0, startedAtMs: NOW, chained: false });
    }
  });
  it('manutenção no hop 0 e a cada N hops', () => {
    expect([0, 1, 4, 5, 6, 10].map((h) => isMaintenanceHop(h, 5))).toEqual([true, false, false, true, false, true]);
    expect(isMaintenanceHop(7, 1)).toBe(true);
  });
});

describe('shouldChainNext — para quando não há trabalho e respeita os máximos', () => {
  const config = { ...resolveTickChainConfig({ DISPARADOR_TICK_CHAIN: '1', NEXT_PUBLIC_APP_URL: 'https://crm.test' }) };
  const ctx = (hop: number, startedAtMs = NOW) => ({ hop, startedAtMs, chained: hop > 0 });

  it('encadeia quando o tick processou trabalho', () => {
    expect(shouldChainNext({ config, ctx: ctx(0), tickStatus: 'processed', nowMs: NOW })).toEqual({ chain: true, reason: 'ok' });
  });
  it('para quando não há item vencido (idle) ou o tick falhou', () => {
    for (const status of ['idle', 'error', 'migration_required', '']) {
      expect(shouldChainNext({ config, ctx: ctx(2), tickStatus: status, nowMs: NOW })).toEqual({ chain: false, reason: 'not_processed' });
    }
  });
  it('desligado ou sem URL própria: nunca encadeia', () => {
    expect(shouldChainNext({ config: { ...config, enabled: false }, ctx: ctx(0), tickStatus: 'processed', nowMs: NOW }).reason).toBe('disabled');
    expect(shouldChainNext({ config: { ...config, baseUrl: null }, ctx: ctx(0), tickStatus: 'processed', nowMs: NOW }).reason).toBe('no_base_url');
  });
  it('máximo de hops por minuto: rajada de hops rápidos é cortada; cadeia mais lenta continua', () => {
    expect(shouldChainNext({ config, ctx: ctx(5, NOW - 10_000), tickStatus: 'processed', nowMs: NOW }).chain).toBe(true); // 6º hop
    expect(shouldChainNext({ config, ctx: ctx(6, NOW - 10_000), tickStatus: 'processed', nowMs: NOW })).toEqual({ chain: false, reason: 'rate_limited' });
    expect(shouldChainNext({ config, ctx: ctx(11, NOW - 120_000), tickStatus: 'processed', nowMs: NOW }).chain).toBe(true); // 12º em 2 min
    expect(shouldChainNext({ config, ctx: ctx(12, NOW - 120_000), tickStatus: 'processed', nowMs: NOW }).chain).toBe(false);
  });
  it('máximo absoluto de hops por cadeia (depois, o cron externo recomeça)', () => {
    const lowMax = { ...config, maxHops: 3 };
    expect(shouldChainNext({ config: lowMax, ctx: ctx(2, NOW - 3_600_000), tickStatus: 'processed', nowMs: NOW }).chain).toBe(true);
    expect(shouldChainNext({ config: lowMax, ctx: ctx(3, NOW - 3_600_000), tickStatus: 'processed', nowMs: NOW })).toEqual({ chain: false, reason: 'max_hops' });
  });
});

describe('fireNextHop', () => {
  const config = resolveTickChainConfig({ DISPARADOR_TICK_CHAIN: '1', DISPARADOR_CHAIN_URL: 'http://127.0.0.1:3000' });

  it('POST ao próprio cron com o mesmo segredo, hop+1 e o mesmo início de cadeia', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 202 }));
    const ok = await fireNextHop({ config, ctx: { hop: 2, startedAtMs: NOW, chained: true }, secret: 's3', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3000/api/disparador/cron');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'x-cron-secret': 's3', [CHAIN_HOP_HEADER]: '3', [CHAIN_START_HEADER]: String(NOW) });
  });

  it('falha de rede não lança (a cadeia só morre; o cron externo retoma)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(fireNextHop({ config, ctx: { hop: 0, startedAtMs: NOW, chained: false }, secret: 's', fetchImpl: fetchImpl as unknown as typeof fetch })).resolves.toBe(false);
    warn.mockRestore();
  });

  it('sem URL base não chama nada', async () => {
    const fetchImpl = vi.fn();
    expect(await fireNextHop({ config: { ...config, baseUrl: null }, ctx: { hop: 0, startedAtMs: NOW, chained: false }, secret: 's', fetchImpl: fetchImpl as unknown as typeof fetch })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
