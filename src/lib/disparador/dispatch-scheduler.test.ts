import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('event loop lento / RSS alto reduz o teto global só após janelas seguidas, nunca abaixo de 25% das vagas', async () => {
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
    expect(report.globalEnd).toBe(2); // piso: 25% de 8
    expect(report.backoffEvents[0]).toEqual(
      expect.objectContaining({ scope: 'global', reason: 'event_loop_lag', from: 8, to: 4 })
    );
    expect(report.started).toBe(40);
  });

  describe('freio do event loop com histerese (F11)', () => {
    const GOOD = { eventLoopLagP99Ms: 10, rssMb: 100 };
    const BAD = { eventLoopLagP99Ms: 900, rssMb: 100 };
    // Cada conclusão de tarefa é uma amostra (relógio avança 10 ms por leitura; intervalo 1 ms).
    async function runWith(samples: Array<typeof GOOD>, slots = 8, total = 60) {
      let clock = 0;
      let i = 0;
      return runDispatchSchedule({
        channels: [{ channelId: 'c1', maxConcurrency: slots, campaigns: [{ campaignId: 'k', items: items('a', total) }] }],
        globalConcurrency: slots,
        shouldStop: () => false,
        now: () => (clock += 10),
        healthCheckIntervalMs: 1,
        sampleHealth: () => samples[Math.min(i++, samples.length - 1)],
        maxEventLoopLagMs: 200,
        maxRssMb: 1024,
        run: async () => { await tick(); },
      });
    }

    it('um pico isolado (ou 2 janelas) NÃO corta as vagas', async () => {
      const spike = await runWith([GOOD, BAD, GOOD]);
      expect(spike.backoffEvents).toEqual([]);
      expect(spike.globalEnd).toBe(8);
      const two = await runWith([GOOD, BAD, BAD, GOOD]);
      expect(two.backoffEvents).toEqual([]);
      expect(two.globalEnd).toBe(8);
    });

    it('3 janelas seguidas acima do limite cortam pela metade', async () => {
      const report = await runWith([BAD, BAD, BAD, GOOD], 8, 40);
      const cut = report.backoffEvents.find((e) => e.scope === 'global' && e.reason === 'event_loop_lag');
      expect(cut).toEqual(expect.objectContaining({ from: 8, to: 4 }));
    });

    it('piso de 25% das vagas iniciais (nunca cai para 1 de uma vez só por insistência)', async () => {
      const report = await runWith(Array(60).fill(BAD), 16, 80);
      expect(report.globalEnd).toBe(4);
      const cuts = report.backoffEvents.filter((e) => e.reason === 'event_loop_lag');
      expect(cuts.map((e) => (e.scope === 'global' ? [e.from, e.to] : null))).toEqual([[16, 8], [8, 4]]);
    });

    it('recupera dentro do tick quando a saúde normaliza (janelas seguidas saudáveis)', async () => {
      const report = await runWith([BAD, BAD, BAD, ...Array(30).fill(GOOD)], 8, 80);
      const events = report.backoffEvents.filter((e) => e.scope === 'global');
      expect(events[0]).toEqual(expect.objectContaining({ reason: 'event_loop_lag', from: 8, to: 4 }));
      expect(events.some((e) => e.reason === 'recovered' && e.scope === 'global' && e.to > e.from)).toBe(true);
      expect(report.globalEnd).toBe(8);
    });
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

describe('token bucket por número (P1-4)', () => {
  afterEach(() => vi.useRealTimers());

  /** Executa o agendador com relógio falso e devolve os instantes (ms desde 0) em que cada item começou. */
  async function simulate(
    channels: ChannelWork<string>[],
    options: { runMs?: number; totalMs: number; globalConcurrency?: number; shouldStop?: () => boolean } = { totalMs: 10_000 }
  ) {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const startedAt: Record<string, number[]> = {};
    let inFlight = 0;
    let peak = 0;
    const promise = runDispatchSchedule<string>({
      channels,
      globalConcurrency: options.globalConcurrency ?? 500,
      shouldStop: options.shouldStop ?? (() => false),
      run: async (item, ctx) => {
        (startedAt[ctx.channelId] ??= []).push(Date.now());
        inFlight++;
        peak = Math.max(peak, inFlight);
        if (options.runMs) await new Promise((r) => setTimeout(r, options.runMs));
        inFlight--;
        void item;
      },
    });
    await vi.advanceTimersByTimeAsync(options.totalMs);
    const report = await promise;
    return { report, startedAt, peak };
  }

  const work = (id: string, n: number, extra: Partial<ChannelWork<string>> = {}): ChannelWork<string> => ({
    channelId: id,
    maxConcurrency: 200,
    campaigns: [{ campaignId: 'k', items: items('i', n) }],
    ...extra,
  });
  const perSecond = (times: number[]) => {
    const buckets: Record<number, number> = {};
    for (const t of times) buckets[Math.floor(t / 1000)] = (buckets[Math.floor(t / 1000)] ?? 0) + 1;
    return buckets;
  };

  it('respeita a taxa: rajada inicial de 1 s (capacidade = rate) e depois ~rate por segundo', async () => {
    const { report, startedAt } = await simulate([work('a', 50, { ratePerSecond: 10 })], { totalMs: 10_000 });
    const buckets = perSecond(startedAt.a);
    expect(startedAt.a.filter((t) => t === 0)).toHaveLength(10); // a rajada de 1 s (capacidade do balde) sai de uma vez
    for (const second of [1, 2, 3]) expect(buckets[second]).toBeGreaterThanOrEqual(9);
    for (const second of [1, 2, 3]) expect(buckets[second]).toBeLessThanOrEqual(11);
    expect(startedAt.a).toHaveLength(50);
    expect(report.started).toBe(50);
    expect(report.channels.a.ratePerSecond).toBe(10);
  });

  it('acumulado: nunca mais que capacidade + rate × tempo (a taxa média é a configurada)', async () => {
    const rate = 8;
    const { startedAt } = await simulate([work('a', 80, { ratePerSecond: rate })], { totalMs: 20_000 });
    const t = startedAt.a;
    expect(t).toHaveLength(80);
    t.forEach((time, index) => {
      expect(index + 1).toBeLessThanOrEqual(rate + (rate * time) / 1000 + 1);
    });
    // e de fato leva ~ (80 − 8) / 8 = 9 s para sair tudo
    expect(Math.max(...t)).toBeGreaterThan(8_000);
  });

  it('sem ratePerSecond (padrão inerte): tudo começa de uma vez, como antes', async () => {
    const { startedAt, report } = await simulate([work('a', 30)], { totalMs: 10 });
    expect(startedAt.a.every((t) => t === 0)).toBe(true);
    expect(report.channels.a.ratePerSecond).toBeNull();
  });

  it('rate 0/negativo/NaN é ignorado (sem limite), nunca trava o número', async () => {
    for (const rate of [0, -3, Number.NaN]) {
      const { startedAt } = await simulate([work('a', 5, { ratePerSecond: rate })], { totalMs: 10 });
      expect(startedAt.a).toHaveLength(5);
    }
  });

  it('as vagas continuam sendo o teto de paralelismo mesmo com taxa alta', async () => {
    const { peak, startedAt } = await simulate([work('a', 40, { ratePerSecond: 1000, maxConcurrency: 3 })], { runMs: 100, totalMs: 5_000 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(startedAt.a).toHaveLength(40);
  });

  it('cada número tem o seu balde (um lento não segura o outro)', async () => {
    const { startedAt } = await simulate([work('lento', 20, { ratePerSecond: 2 }), work('rapido', 20, { ratePerSecond: 20 })], { totalMs: 10_000 });
    expect(startedAt.rapido.filter((t) => t === 0)).toHaveLength(20);
    expect(startedAt.lento.filter((t) => t === 0)).toHaveLength(2);
    expect(Math.max(...startedAt.lento)).toBeGreaterThan(5_000);
    expect(Math.max(...startedAt.rapido)).toBeLessThan(1_000);
  });

  it('parada do tick (orçamento) enquanto espera token: encerra sem travar e reporta o que não começou', async () => {
    let stop = false;
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const promise = runDispatchSchedule<string>({
      channels: [work('a', 100, { ratePerSecond: 5 })],
      globalConcurrency: 50,
      shouldStop: () => stop,
      run: async () => {},
    });
    await vi.advanceTimersByTimeAsync(1500);
    stop = true;
    await vi.advanceTimersByTimeAsync(1500);
    const report = await promise;
    expect(report.stoppedEarly).toBe(true);
    expect(report.started).toBeLessThan(100);
    expect(report.notStarted).toBe(100 - report.started);
  });
});
