import { describe, expect, it } from 'vitest';
import { runDispatchSchedule, type ChannelWork, type TaskOutcome } from './dispatch-scheduler';
import { processWithConcurrency } from './concurrency';
import { classifyProviderError } from './provider-signals';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// Tarefa que registra início/fim e a concorrência observada (global e por número).
function tracker(delay = () => tick()) {
  const order: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const perChannel = new Map<string, { now: number; peak: number }>();
  const run = async (item: string, ctx: { channelId: string }): Promise<TaskOutcome | void> => {
    order.push(item);
    inFlight++;
    peak = Math.max(peak, inFlight);
    const channel = perChannel.get(ctx.channelId) ?? { now: 0, peak: 0 };
    channel.now++;
    channel.peak = Math.max(channel.peak, channel.now);
    perChannel.set(ctx.channelId, channel);
    await delay();
    inFlight--;
    channel.now--;
  };
  return { order, run, peak: () => peak, perChannel };
}

const items = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

describe('runDispatchSchedule', () => {
  it('pausa uma campanha em todos os números e mantém fairness e notStarted', async () => {
    const order: string[] = [];
    const report = await runDispatchSchedule({
      channels: [
        { channelId: 'a', maxConcurrency: 1, campaigns: [
          { campaignId: 'pause', items: ['p0', 'p1'] },
          { campaignId: 'other', items: ['o0', 'o1'] },
        ] },
        { channelId: 'b', maxConcurrency: 1, campaigns: [{ campaignId: 'pause', items: ['p2'] }] },
      ],
      globalConcurrency: 1,
      shouldStop: () => false,
      run: async (item) => { order.push(item); return { pauseCampaign: item === 'p0' }; },
    });
    expect(order).toEqual(['p0', 'o0', 'o1']);
    expect(report).toMatchObject({ started: 3, notStarted: 2, stoppedEarly: true });
    expect(report.channels.b).toMatchObject({ started: 0, notStarted: 1 });
  });

  it('padrões == comportamento antigo: 1 campanha, mesma ordem e mesma concorrência do processWithConcurrency(4)', async () => {
    const list = items('a', 23);
    const before = tracker();
    await processWithConcurrency(list, 4, async (item) => {
      await before.run(item, { channelId: 'c1' });
    });
    const after = tracker();
    const report = await runDispatchSchedule({
      channels: [{ channelId: 'c1', maxConcurrency: 4, campaigns: [{ campaignId: 'k1', items: list }] }],
      globalConcurrency: 4,
      shouldStop: () => false,
      run: after.run,
    });
    expect(after.order).toEqual(before.order);
    expect(after.peak()).toBe(before.peak());
    expect(after.peak()).toBe(4);
    expect(report.started).toBe(23);
    expect(report.notStarted).toBe(0);
    expect(report.stoppedEarly).toBe(false);
  });

  it('round-robin entre campanhas do mesmo número: uma campanha grande não segura as outras', async () => {
    const t = tracker();
    await runDispatchSchedule({
      channels: [
        {
          channelId: 'c1',
          maxConcurrency: 1,
          campaigns: [
            { campaignId: 'big', items: items('big', 6) },
            { campaignId: 'small', items: items('small', 2) },
            { campaignId: 'seq', items: ['seq0'] },
          ],
        },
      ],
      globalConcurrency: 4,
      shouldStop: () => false,
      run: t.run,
    });
    expect(t.order).toEqual(['big0', 'small0', 'seq0', 'big1', 'small1', 'big2', 'big3', 'big4', 'big5']);
  });

  it('números rodam em paralelo, cada um no seu teto, e o global limita o total', async () => {
    const t = tracker(() => new Promise((resolve) => setTimeout(resolve, 5)));
    const report = await runDispatchSchedule({
      channels: [
        { channelId: 'c1', maxConcurrency: 3, campaigns: [{ campaignId: 'k1', items: items('a', 9) }] },
        { channelId: 'c2', maxConcurrency: 3, campaigns: [{ campaignId: 'k2', items: items('b', 9) }] },
        { channelId: 'c3', maxConcurrency: 3, campaigns: [{ campaignId: 'k3', items: items('c', 9) }] },
      ],
      globalConcurrency: 6,
      shouldStop: () => false,
      run: t.run,
    });
    expect(t.peak()).toBe(6);
    for (const id of ['c1', 'c2', 'c3']) {
      expect(t.perChannel.get(id)!.peak).toBeLessThanOrEqual(3);
      expect(report.channels[id].started).toBe(9);
    }
    // Vagas globais repartidas entre os números desde o início.
    expect(new Set(t.order.slice(0, 6).map((item) => item[0]))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('com global 8 e dois números de teto 4, os dois enviam ao mesmo tempo', async () => {
    const t = tracker(() => new Promise((resolve) => setTimeout(resolve, 5)));
    await runDispatchSchedule({
      channels: [
        { channelId: 'c1', maxConcurrency: 4, campaigns: [{ campaignId: 'k1', items: items('a', 8) }] },
        { channelId: 'c2', maxConcurrency: 4, campaigns: [{ campaignId: 'k2', items: items('b', 8) }] },
      ],
      globalConcurrency: 8,
      shouldStop: () => false,
      run: t.run,
    });
    expect(t.peak()).toBe(8);
    expect(t.perChannel.get('c1')!.peak).toBe(4);
    expect(t.perChannel.get('c2')!.peak).toBe(4);
  });

  it('respeita o orçamento: nada começa depois de shouldStop, o que já começou termina', async () => {
    let stop = false;
    const t = tracker();
    const finished: string[] = [];
    const report = await runDispatchSchedule({
      channels: [{ channelId: 'c1', maxConcurrency: 2, campaigns: [{ campaignId: 'k1', items: items('a', 10) }] }],
      globalConcurrency: 2,
      shouldStop: () => stop,
      run: async (item, ctx) => {
        await t.run(item, ctx);
        finished.push(item);
        if (finished.length === 3) stop = true;
      },
    });
    expect(finished).toEqual(t.order);
    expect(report.started).toBe(4); // 2 iniciais + 2 que já tinham começado antes do stop
    expect(report.notStarted).toBe(6);
    expect(report.stoppedEarly).toBe(true);
  });

  it('sem trabalho termina na hora', async () => {
    const report = await runDispatchSchedule({ channels: [], globalConcurrency: 4, shouldStop: () => false, run: async () => {} });
    expect(report.started).toBe(0);
  });

  it('rate limit real reduz o número imediatamente, mas no máximo uma vez por tick', async () => {
    const t = tracker(() => new Promise((resolve) => setTimeout(resolve, 2)));
    const events: unknown[] = [];
    const signals = [
      classifyProviderError(new MetaApiError('rate', 131056, 400)).reason,
      classifyProviderError(new MetaApiError('too many', null, 429)).reason,
    ];
    const work: ChannelWork<string>[] = [
      { channelId: 'hot', maxConcurrency: 8, campaigns: [{ campaignId: 'k1', items: items('h', 30) }] },
      { channelId: 'ok', maxConcurrency: 4, campaigns: [{ campaignId: 'k2', items: items('o', 30) }] },
    ];
    const report = await runDispatchSchedule({
      channels: work,
      globalConcurrency: 12,
      shouldStop: () => false,
      onBackoff: (event) => events.push(event),
      run: async (item, ctx) => {
        await t.run(item, ctx);
        if (item === 'h0') return { backoff: signals[0] };
        if (item === 'h1') return { backoff: signals[1] };
      },
    });
    expect(signals).toEqual(['rate_limit', 'rate_limit']);
    expect(report.channels.hot.capStart).toBe(8);
    expect(report.channels.hot.capEnd).toBe(4);
    expect(report.channels.ok.capEnd).toBe(4);
    expect(report.backoffEvents).toEqual([
      expect.objectContaining({ scope: 'channel', channelId: 'hot', reason: 'rate_limit', from: 8, to: 4 }),
    ]);
    expect(events).toHaveLength(1);
    expect(report.channels.hot.started).toBe(30);
  });

  it('2 erros transitórios isolados não acionam freio nem reduzem concorrência', async () => {
    const report = await runDispatchSchedule({
      channels: [{ channelId: 'meta', maxConcurrency: 24, campaigns: [{ campaignId: 'k', items: items('a', 120) }] }],
      globalConcurrency: 24,
      shouldStop: () => false,
      run: async (item) => {
        if (item === 'a20' || item === 'a80') return { backoff: 'server_error' };
      },
    });
    expect(report.channels.meta.capEnd).toBe(24);
    expect(report.backoffEvents).toEqual([]);
  });

  it('erros transitórios recorrentes na janela recente reduzem uma única vez', async () => {
    const transient = new Set(['a20', 'a30', 'a40', 'a50', 'a60']);
    const report = await runDispatchSchedule({
      channels: [{ channelId: 'meta', maxConcurrency: 24, campaigns: [{ campaignId: 'k', items: items('a', 140) }] }],
      globalConcurrency: 24,
      shouldStop: () => false,
      run: async (item) => {
        if (transient.has(item)) return { backoff: item === 'a60' ? 'timeout' : 'server_error' };
      },
    });
    expect(report.channels.meta.capStart).toBe(24);
    expect(report.channels.meta.capEnd).toBe(12);
    expect(report.backoffEvents).toHaveLength(1);
    expect(report.backoffEvents[0]).toEqual(
      expect.objectContaining({ scope: 'channel', channelId: 'meta', from: 24, to: 12 })
    );
  });

  it('backoff desligado não mexe na concorrência', async () => {
    const report = await runDispatchSchedule({
      channels: [{ channelId: 'c1', maxConcurrency: 4, campaigns: [{ campaignId: 'k', items: items('a', 5) }] }],
      globalConcurrency: 4,
      adaptiveBackoff: false,
      shouldStop: () => false,
      run: async () => ({ backoff: 'rate_limit' }),
    });
    expect(report.channels.c1.capEnd).toBe(4);
    expect(report.backoffEvents).toEqual([]);
  });

  it('event loop lento / RSS alto reduz o teto global (nunca abaixo de 1)', async () => {
    let clock = 0;
    const t = tracker();
    const report = await runDispatchSchedule({
      channels: [{ channelId: 'c1', maxConcurrency: 8, campaigns: [{ campaignId: 'k', items: items('a', 40) }] }],
      globalConcurrency: 8,
      shouldStop: () => false,
      now: () => (clock += 600),
      healthCheckIntervalMs: 1_000,
      sampleHealth: () => ({ eventLoopLagP99Ms: 500, rssMb: 2048 }),
      maxEventLoopLagMs: 200,
      maxRssMb: 1024,
      run: t.run,
    });
    expect(report.globalStart).toBe(8);
    expect(report.globalEnd).toBe(1);
    expect(report.backoffEvents[0]).toEqual(
      expect.objectContaining({ scope: 'global', reason: 'event_loop_lag', from: 8, to: 4 })
    );
    expect(report.started).toBe(40);
  });

  it('erro inesperado da tarefa não derruba o lote', async () => {
    const report = await runDispatchSchedule({
      channels: [{ channelId: 'c1', maxConcurrency: 2, campaigns: [{ campaignId: 'k', items: items('a', 4) }] }],
      globalConcurrency: 2,
      shouldStop: () => false,
      run: async (item) => {
        if (item === 'a1') throw new Error('boom');
      },
    });
    expect(report.started).toBe(4);
  });
});

describe('classifyProviderError', () => {
  it('classifica sinais de limite, 5xx, timeout e rede', () => {
    expect(classifyProviderError(new MetaApiError('spam', 131048, 400))).toEqual({ reason: 'rate_limit', code: 'meta:131048' });
    expect(classifyProviderError(new MetaApiError('pair', 131056, 400))).toEqual({ reason: 'rate_limit', code: 'meta:131056' });
    expect(classifyProviderError(new MetaApiError('x', null, 503))).toEqual({ reason: 'server_error', code: 'meta:http_503' });
    expect(classifyProviderError(new MetaApiError('invalid', 131026, 400))).toEqual({ reason: null, code: 'meta:131026' });
    expect(classifyProviderError(new Error('WAHA sendText failed (429): slow down')).reason).toBe('rate_limit');
    expect(classifyProviderError(new Error('WAHA sendText failed (502): bad gw')).reason).toBe('server_error');
    expect(classifyProviderError(new Error('WAHA sendText failed (400): bad')).reason).toBeNull();
    expect(classifyProviderError(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })).reason).toBe('timeout');
    expect(classifyProviderError(new TypeError('fetch failed')).reason).toBe('network');
  });
});
