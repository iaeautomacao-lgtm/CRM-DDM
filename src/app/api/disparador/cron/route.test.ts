import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  process: vi.fn(),
  start: vi.fn(),
  callback: vi.fn(),
}));
vi.mock('@/lib/disparador/admin-client', () => ({
  supabaseAdmin: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock('@/lib/disparador/processQueue', () => ({
  processQueueItem: mocks.process,
  checkWithinWindow: () => true,
  sendCampaignCallback: mocks.callback,
}));
vi.mock('@/lib/disparador/startCampaign', () => ({
  startCampaign: mocks.start,
}));
const reflowMocks = vi.hoisted(() => ({ reflow: vi.fn() }));
vi.mock('@/lib/disparador/queue-reflow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/disparador/queue-reflow')>()),
  reflowCampaignQueue: reflowMocks.reflow,
}));
vi.mock('@/lib/disparador/callback-outbox', () => ({ drainCallbackOutbox: vi.fn() }));
vi.mock('@/lib/audit/context', () => ({ registerAuditActor: vi.fn() }));
import { GET, POST } from './route';

describe('cron: reflow da fila de campanha em lote', () => {
  // 19/10/2026 = segunda; janela 08–18 seg–sex.
  const br = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 9, day, hh + 3, mm));
  const campaign = {
    id: 'camp',
    account_id: 'acc',
    status: 'em_execucao',
    janela_inicio: '08:00',
    janela_fim: '18:00',
    dias_envio: [1, 2, 3, 4, 5],
    batch_size: 2,
    batch_pause_seconds: 1800,
  };
  function setup(dueItems: Array<Record<string, unknown>>) {
    vi.stubEnv('CRON_SECRET', 'test-secret');
    mocks.rpc.mockResolvedValue({ data: true, error: null });
    mocks.from.mockImplementation((table: string) => {
      let result: { data: unknown; error: null } = { data: [], error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['eq', 'lte', 'lt', 'order', 'limit', 'update'])
        builder[m] = (...args: unknown[]) => {
          if (table === 'campaigns' && m === 'eq' && args[1] === 'em_execucao') result = { data: [campaign], error: null };
          return builder;
        };
      builder.select = () => {
        if (table === 'disp_message_queue') result = { data: dueItems, error: null };
        return builder;
      };
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return builder;
    });
  }
  const post = () =>
    POST(new Request('https://crm.test/api/disparador/cron', { method: 'POST', headers: { 'x-cron-secret': 'test-secret' } }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('fila antiga com rodadas no fim de semana: redistribui e não envia neste tick', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(br(19, 8, 1));
    setup([
      { id: 'a', campaign_id: 'camp', scheduled_at: br(17, 10).toISOString(), tentativas: 0 },
      { id: 'b', campaign_id: 'camp', scheduled_at: br(19, 8).toISOString(), tentativas: 0 },
    ]);
    reflowMocks.reflow.mockResolvedValue({ ok: true, items: 2, updated: 2, via: 'rpc' });
    expect((await post()).status).toBe(200);
    expect(reflowMocks.reflow).toHaveBeenCalledTimes(1);
    expect(mocks.process).not.toHaveBeenCalled();
  });

  it('fila consistente: não redistribui e envia normalmente', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(br(19, 9, 1));
    setup([{ id: 'b', campaign_id: 'camp', scheduled_at: br(19, 9).toISOString(), tentativas: 0 }]);
    mocks.process.mockResolvedValue({ outcome: 'sent', messageId: 'x' });
    expect((await post()).status).toBe(200);
    expect(reflowMocks.reflow).not.toHaveBeenCalled();
    expect(mocks.process).toHaveBeenCalledTimes(1);
  });
});

describe('dispatch cron authentication and diagnostics', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  it('fails closed when not configured, without touching the queue', async () => {
    vi.stubEnv('CRON_SECRET', '');
    expect(
      (
        await POST(
          new Request('https://crm.test/api/disparador/cron', {
            method: 'POST',
          })
        )
      ).status
    ).toBe(503);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('rejects an invalid credential before any database operation', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret');
    expect(
      (
        await POST(
          new Request('https://crm.test/api/disparador/cron', {
            method: 'POST',
            headers: { 'x-cron-secret': 'wrong' },
          })
        )
      ).status
    ).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('GET is read-only and cannot start, retry, claim, complete or send', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret');
    const limit = vi.fn(async () => ({ error: null }));
    mocks.from.mockReturnValue({ select: () => ({ limit }) });
    const response = await GET(
      new Request('https://crm.test/api/disparador/cron', {
        headers: { 'x-cron-secret': 'test-secret' },
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.from).toHaveBeenCalledWith('campaigns');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.callback).not.toHaveBeenCalled();
  });
});
