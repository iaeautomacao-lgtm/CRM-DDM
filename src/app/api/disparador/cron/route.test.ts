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
const logMocks = vi.hoisted(() => ({ writeLog: vi.fn() }));
vi.mock('@/lib/logger', () => ({ writeLog: logMocks.writeLog }));
const pauseMocks = vi.hoisted(() => ({ check: vi.fn().mockResolvedValue(false) }));
vi.mock('@/lib/disparador/auto-pause', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/disparador/auto-pause')>()),
  checkCampaignAutoPause: pauseMocks.check,
}));
vi.mock('@/lib/disparador/receipts-cleanup', () => ({ cleanupOrphanReceipts: vi.fn() }));
vi.mock('@/lib/disparador/reconcile-unknown-provider-outcomes', () => ({
  recoverStaleSendingReservations: vi.fn(async () => ({
    recoveredAccepted: 0,
    finalizedUnknown: 0,
    failed: 0,
    campaignIds: [],
  })),
}));
import { GET, POST } from './route';
import { clearMemoryCooldowns } from '@/lib/disparador/throughput-config';

describe('cron: agendador por número', () => {
  const campaignBase = {
    account_id: 'acc',
    status: 'em_execucao',
    janela_inicio: '00:00',
    janela_fim: '23:59',
    dias_envio: [],
    batch_size: 50,
    batch_pause_seconds: 60,
  };
  const campaigns = [
    { ...campaignBase, id: 'big' },
    { ...campaignBase, id: 'small' },
  ];
  const queue: Record<string, Array<Record<string, unknown>>> = {
    big: Array.from({ length: 6 }, (_, i) => ({ id: `big${i}`, campaign_id: 'big', session_id: 'ch-meta', tentativas: 0 })),
    small: [
      { id: 'small0', campaign_id: 'small', session_id: 'ch-meta', tentativas: 0 },
      { id: 'small1', campaign_id: 'small', session_id: 'ch-waha', tentativas: 0 },
    ],
  };
  const upserts: unknown[] = [];
  // Campanhas 'agendado' vencidas devolvidas pelo banco falso (B9).
  let dueScheduled: Array<Record<string, unknown>> = [];
  function setup(limits: Array<Record<string, unknown>> = []) {
    vi.stubEnv('CRON_SECRET', 'test-secret');
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'blacklisted_phone_keys' ? { data: [], error: null } : { data: true, error: null }
    );
    mocks.from.mockImplementation((table: string) => {
      let result: { data: unknown; error: unknown } = { data: [], error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['lte', 'lt', 'gt', 'order', 'limit', 'range', 'update', 'in', 'not', 'is'])
        builder[m] = () => builder;
      builder.eq = (column: string, value: unknown) => {
        if (table === 'campaigns' && value === 'em_execucao') result = { data: campaigns, error: null };
        if (table === 'campaigns' && value === 'agendado') result = { data: dueScheduled, error: null };
        if (table === 'disp_message_queue' && column === 'campaign_id')
          result = { data: queue[value as string] ?? [], error: null };
        return builder;
      };
      builder.select = () => {
        if (table === 'whatsapp_config')
          result = { data: [{ id: 'ch-meta', provider: 'meta', account_id: 'acc' }, { id: 'ch-waha', provider: 'waha', account_id: 'acc' }], error: null };
        if (table === 'dispatch_channel_limits') result = { data: limits, error: null };
        return builder;
      };
      builder.upsert = (row: unknown) => {
        upserts.push(row);
        return builder;
      };
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return builder;
    });
  }
  const post = () =>
    POST(new Request('https://crm.test/api/disparador/cron', { method: 'POST', headers: { 'x-cron-secret': 'test-secret' } }));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    clearMemoryCooldowns();
    upserts.length = 0;
    dueScheduled = [];
    pauseMocks.check.mockResolvedValue(false);
  });

  it('rede de segurança do webhook (migration 185): aplica o inbox de status em lotes enquanto vier lote cheio', async () => {
    setup();
    let batches = 0;
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'apply_dispatch_statuses') {
        batches++;
        return { data: { claimed: batches < 3 ? 1000 : 120, fast: 0, slow: 0, failed: 0 }, error: null };
      }
      return name === 'blacklisted_phone_keys' ? { data: [], error: null } : { data: true, error: null };
    });
    expect((await post()).status).toBe(200);
    expect(batches).toBe(3);
    expect(mocks.rpc.mock.calls.filter(([n]) => n === 'apply_dispatch_statuses').every(([, a]) => a.p_limit === 1000)).toBe(true);
  });

  it('sem a migration 185 o tick segue normal (drenagem é no-op)', async () => {
    setup();
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'apply_dispatch_statuses') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
      return name === 'blacklisted_phone_keys' ? { data: [], error: null } : { data: true, error: null };
    });
    const res = await post();
    expect(res.status).toBe(200);
    expect(mocks.rpc.mock.calls.filter(([n]) => n === 'apply_dispatch_statuses')).toHaveLength(1);
  });

  it('B9: por padrão o tick ainda prepara as campanhas agendadas vencidas (fallback)', async () => {
    setup();
    dueScheduled = [{ id: 'sch', account_id: 'acc' }];
    mocks.start.mockResolvedValue({ ok: true, enqueued: 1 });
    mocks.process.mockResolvedValue({ outcome: 'sent', messageId: 'x' });
    expect((await post()).status).toBe(200);
    expect(mocks.start).toHaveBeenCalledWith('sch', 'acc');
  });

  it('B9: com DISPARADOR_PREPARE_IN_TICK=false o tick NÃO prepara (só a rota nova) e continua enviando', async () => {
    setup();
    vi.stubEnv('DISPARADOR_PREPARE_IN_TICK', 'false');
    dueScheduled = [{ id: 'sch', account_id: 'acc' }];
    mocks.process.mockResolvedValue({ outcome: 'sent', messageId: 'x' });
    const response = await post();
    expect(response.status).toBe(200);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.process).toHaveBeenCalled();
  });

  it('alterna campanhas no mesmo número, roda números em paralelo e grava UM cron_tick', async () => {
    setup();
    vi.stubEnv('DISPATCH_PROCESS_CONCURRENCY', '1');
    const started: string[] = [];
    mocks.process.mockImplementation(async (item: { id: string }) => {
      started.push(item.id);
      return { outcome: 'sent', messageId: item.id };
    });
    const response = await post();
    const body = await response.json();
    expect(response.status).toBe(200);
    // Global 1: vagas alternam entre números; no número Meta, alternam campanhas.
    expect(started.slice(0, 4)).toEqual(['big0', 'small1', 'small0', 'big1']);
    expect(started).toHaveLength(8);
    expect(body.results).toEqual([
      { campaign_id: 'big', sent: 6, pending_confirmation: 0 },
      { campaign_id: 'small', sent: 2, pending_confirmation: 0 },
    ]);
    expect(body.process_concurrency).toBe(1);
    // Padrão 4 por número = padrão do banco → claim normal (sem _capped).
    expect(mocks.process.mock.calls[0][2]).toMatchObject({ defaultMaxInFlight: 4 });
    const ticks = logMocks.writeLog.mock.calls.filter(([entry]) => entry.event === 'cron_tick');
    expect(ticks).toHaveLength(1);
    expect(ticks[0][0]).toMatchObject({
      source: 'disparador',
      level: 'info',
      payload: {
        status: 'processed',
        campaigns: 2,
        totals: { sent: 8 },
        channels: { 'ch-meta': { provider: 'meta', sent: 7 }, 'ch-waha': { provider: 'waha', sent: 1 } },
      },
    });
  });

  it('linha de dispatch_channel_limits define o teto do número; 131056 dispara backoff e cooldown', async () => {
    setup([{ session_id: 'ch-meta', max_in_flight: 8, hourly_limit: null }]);
    vi.stubEnv('DISPATCH_PROCESS_CONCURRENCY', '16');
    mocks.process.mockImplementation(
      async (item: { id: string }, _campaign: unknown, options: { onProviderCall?: (o: unknown) => void }) => {
        const limited = item.id === 'big0';
        options.onProviderCall?.({
          provider: 'meta',
          latencyMs: 120,
          ok: !limited,
          signal: limited ? 'rate_limit' : null,
          code: limited ? 'meta:131056' : null,
        });
        return limited ? { outcome: 'error', error: 'pair rate limit' } : { outcome: 'sent', messageId: item.id };
      }
    );
    expect((await post()).status).toBe(200);
    const metaCall = mocks.process.mock.calls.find(([item]) => item.session_id === 'ch-meta');
    // Com linha no banco, o claim usa a linha (sem padrão do app).
    expect(metaCall?.[2].defaultMaxInFlight).toBeUndefined();
    const tick = logMocks.writeLog.mock.calls.find(([entry]) => entry.event === 'cron_tick')?.[0];
    expect(tick.level).toBe('warn');
    expect(tick.payload.channels['ch-meta']).toMatchObject({ concurrency_start: 8, concurrency_end: 4 });
    expect(tick.payload.provider_errors).toEqual({ 'meta:131056': 1 });
    expect(tick.payload.backoff_events[0]).toMatchObject({ scope: 'channel', session_id: 'ch-meta', reason: 'rate_limit' });
    expect(upserts).toEqual([expect.objectContaining({ session_id: 'ch-meta', reason: 'rate_limit' })]);
  });

  it('orçamento esgotado no meio do tick: nenhum envio novo começa depois', async () => {
    setup();
    vi.stubEnv('DISPATCH_PROCESS_CONCURRENCY', '1');
    vi.stubEnv('DISPARADOR_TICK_BUDGET_MS', '5000');
    const start = Date.now();
    let late = false;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (late ? start + 60_000 : start));
    mocks.process.mockImplementation(async () => {
      late = true; // o primeiro envio "demora" além do orçamento
      return { outcome: 'sent', messageId: 'x' };
    });
    await post();
    nowSpy.mockRestore();
    expect(mocks.process).toHaveBeenCalledTimes(1);
    const tick = logMocks.writeLog.mock.calls.find(([entry]) => entry.event === 'cron_tick')?.[0];
    expect(tick.payload).toMatchObject({ budget_ms: 5000, stopped_early: true, totals: { sent: 1, not_started: 7 } });
  });

  it('pausa antes do planejamento sem afetar outra campanha ou cron_tick', async () => {
    setup();
    pauseMocks.check.mockImplementation(async (_db, campaign) => campaign.id === 'big');
    mocks.process.mockResolvedValue({ outcome: 'sent', messageId: 'x' });
    expect((await post()).status).toBe(200);
    expect(mocks.process.mock.calls.map(([item]) => item.id).sort()).toEqual(['small0', 'small1']);
    expect(logMocks.writeLog.mock.calls.filter(([entry]) => entry.event === 'cron_tick')).toHaveLength(1);
  });

  it('pausa durante o lote e preserva os candidatos não iniciados na telemetria', async () => {
    setup();
    vi.stubEnv('DISPATCH_PROCESS_CONCURRENCY', '1');
    vi.stubEnv('DISPARADOR_AUTO_PAUSE_MIN_ATTEMPTS', '2');
    const evaluations = new Map<string, number>();
    pauseMocks.check.mockImplementation(async (_db, campaign) => {
      const count = (evaluations.get(campaign.id) ?? 0) + 1;
      evaluations.set(campaign.id, count);
      return campaign.id === 'big' && count > 1;
    });
    mocks.process.mockResolvedValue({ outcome: 'error', error: '(#132001) template inexistente' });
    expect((await post()).status).toBe(200);
    expect(mocks.process.mock.calls.filter(([item]) => item.campaign_id === 'big')).toHaveLength(2);
    expect(mocks.process.mock.calls.filter(([item]) => item.campaign_id === 'small')).toHaveLength(2);
    const tick = logMocks.writeLog.mock.calls.find(([entry]) => entry.event === 'cron_tick')?.[0];
    expect(tick.payload).toMatchObject({ stopped_early: true, totals: { not_started: 4 } });
  });

  it('canal e blacklist carregados uma vez no tick e repassados a cada envio', async () => {
    setup();
    queue.small[0].mensagem_final = '+5511999998888';
    queue.small[1].mensagem_final = '21987654321';
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'blacklisted_phone_keys' ? { data: [{ key: '1199998888' }], error: null } : { data: true, error: null }
    );
    mocks.process.mockResolvedValue({ outcome: 'sent', messageId: 'x' });
    try {
      expect((await post()).status).toBe(200);
    } finally {
      delete queue.small[0].mensagem_final;
      delete queue.small[1].mensagem_final;
    }
    const keyCalls = mocks.rpc.mock.calls.filter(([name]) => name === 'blacklisted_phone_keys');
    expect(keyCalls).toHaveLength(1);
    expect([...keyCalls[0][1].p_keys].sort()).toEqual(['1199998888', '2187654321']);
    const optionsFor = (id: string) => mocks.process.mock.calls.find(([item]) => item.id === id)?.[2];
    const small0 = optionsFor('small0');
    expect(small0.channelConfig).toMatchObject({ id: 'ch-meta', provider: 'meta' });
    expect(small0.blacklistLookup('+55 11 99999-8888')).toBe(true);
    expect(small0.blacklistLookup('21 98765-4321')).toBe(false);
    // Telefone que não estava no tick: o envio consulta o banco.
    expect(small0.blacklistLookup('31911112222')).toBeUndefined();
    expect(optionsFor('small1').channelConfig).toMatchObject({ id: 'ch-waha' });
    // whatsapp_config lido uma vez só no tick.
    expect(mocks.from.mock.calls.filter(([table]) => table === 'whatsapp_config')).toHaveLength(1);
  });

  it('canal de outra conta chega como null (o envio fecha como canal não encontrado)', async () => {
    setup();
    campaigns[1].account_id = 'other';
    mocks.process.mockResolvedValue({ outcome: 'sent', messageId: 'x' });
    try {
      await post();
    } finally {
      campaigns[1].account_id = 'acc';
    }
    const small0 = mocks.process.mock.calls.find(([item]) => item.id === 'small0')?.[2];
    expect(small0.channelConfig).toBeNull();
  });

  it('retry de erros transitórios só no tick que pega o lock; falha nele não derruba o tick', async () => {
    setup();
    mocks.process.mockResolvedValue({ outcome: 'sent', messageId: 'x' });
    mocks.rpc.mockImplementation(async (name: string, args?: { p_name?: string }) => {
      if (name === 'try_acquire_cron_lock' && args?.p_name === 'disparador_retry') return { data: false, error: null };
      if (name === 'blacklisted_phone_keys') return { data: [], error: null };
      return { data: true, error: null };
    });
    expect((await post()).status).toBe(200);
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'retry_transient_queue_errors')).toBe(false);
    const lockCall = mocks.rpc.mock.calls.find(([name, args]) => name === 'try_acquire_cron_lock' && args.p_name === 'disparador_retry');
    expect(lockCall?.[1].p_ttl_seconds).toBe(270);

    vi.clearAllMocks();
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === 'retry_transient_queue_errors') return { data: null, error: { message: 'statement timeout' } };
      if (name === 'blacklisted_phone_keys') return { data: [], error: null };
      return { data: true, error: null };
    });
    mocks.process.mockResolvedValue({ outcome: 'sent', messageId: 'x' });
    expect((await post()).status).toBe(200);
    expect(mocks.rpc.mock.calls.some(([name]) => name === 'retry_transient_queue_errors')).toBe(true);
    expect(mocks.process).toHaveBeenCalled();
  });
});

describe('cron: candidatos por campanha', () => {
  it('teto derivado da vazão do tick, em páginas de 1.000 (max-rows do PostgREST)', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret');
    vi.stubEnv('DISPATCH_PROCESS_CONCURRENCY', '48');
    vi.stubEnv('DISPARADOR_TICK_BUDGET_MS', '45000');
    const campaign = {
      id: 'imediato', account_id: 'acc', status: 'em_execucao', janela_inicio: '00:00', janela_fim: '23:59',
      dias_envio: [], batch_size: 999_999, batch_pause_seconds: 0,
    };
    const ranges: Array<[number, number]> = [];
    const total = 10_000;
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'blacklisted_phone_keys' ? { data: [], error: null } : { data: true, error: null }
    );
    mocks.from.mockImplementation((table: string) => {
      let result: { data: unknown; error: null } = { data: [], error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['lte', 'lt', 'order', 'limit', 'update', 'in', 'select', 'not', 'is']) builder[m] = () => builder;
      builder.eq = (_column: string, value: unknown) => {
        if (table === 'campaigns' && value === 'em_execucao') result = { data: [campaign], error: null };
        return builder;
      };
      builder.range = (from: number, to: number) => {
        ranges.push([from, to]);
        const rows = [];
        for (let i = from; i <= Math.min(to, from + 999, total - 1); i++)
          rows.push({ id: `i${i}`, campaign_id: 'imediato', session_id: 'ch', tentativas: 0 });
        result = { data: rows, error: null };
        return builder;
      };
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return builder;
    });
    mocks.process.mockResolvedValue({ outcome: 'deferred', reason: 'already_claimed' });
    try {
      expect((await POST(new Request('https://crm.test/api/disparador/cron', { method: 'POST', headers: { 'x-cron-secret': 'test-secret' } }))).status).toBe(200);
    } finally {
      vi.unstubAllEnvs();
    }
    // 48 × 45 s ÷ 0,5 s = 4.320 (antes: 700 fixos).
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999], [3000, 3999], [4000, 4319]]);
    expect(mocks.process).toHaveBeenCalledTimes(4320);
    vi.clearAllMocks();
  });
});

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
    mocks.rpc.mockImplementation(async (name: string) =>
      name === 'blacklisted_phone_keys' ? { data: [], error: null } : { data: true, error: null }
    );
    mocks.from.mockImplementation((table: string) => {
      let result: { data: unknown; error: null } = { data: [], error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ['eq', 'lte', 'lt', 'order', 'limit', 'range', 'update', 'not', 'is'])
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
