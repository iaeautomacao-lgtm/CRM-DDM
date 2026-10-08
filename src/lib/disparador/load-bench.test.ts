// Bancada de carga: trava de segurança do alvo, parser de métricas e a Meta simulada (scripts/lib/*.mjs).
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertSafeLoadTarget,
  formatTable,
  parseTickRow,
  percentile,
  summarizeMock,
  summarizeTicks,
} from '../../../scripts/loadtest/lib/load-metrics.mjs';
import { AUDIT_ERROR_RATES, buildQualityPayload, buildStatusPayload, createMetaMock, parseErrorRates, pickError, sampleLatencyMs, signWebhookBody } from '../../../scripts/loadtest/lib/meta-mock.mjs';
import { LOADTEST_FORBIDDEN_SUPABASE_REFS as MJS_REFS } from '../../../scripts/loadtest/lib/forbidden.mjs';
import { LOADTEST_FORBIDDEN_SUPABASE_REFS } from '../loadtest/gate';

const baseEnv = {
  LOAD_SUPABASE_URL: 'https://projeto-de-teste.supabase.co',
  LOAD_SUPABASE_SERVICE_ROLE_KEY: 'chave-de-teste',
  LOAD_ACCOUNT_ID: 'acc',
  LOAD_USER_ID: 'user',
  LOAD_APP_URL: 'http://localhost:3000',
  LOAD_CRON_SECRET: 'cron',
  LOAD_CONFIRM_TEST_DB: 'yes',
};

describe('assertSafeLoadTarget', () => {
  it('aceita um alvo de teste e aplica os limites', () => {
    const cfg = assertSafeLoadTarget({ ...baseEnv, LOAD_CHANNELS: '999', LOAD_ITEMS: '50000' });
    expect(cfg.appUrl).toBe('http://localhost:3000');
    expect(cfg.channels).toBe(50);
    expect(cfg.itemsPerCampaign).toBe(20000);
  });

  it('RECUSA o Supabase de produção', () => {
    expect(() => assertSafeLoadTarget({ ...baseEnv, LOAD_SUPABASE_URL: 'https://cyftbffhgjmsfogxawrl.supabase.co' })).toThrow(/PRODUÇÃO/);
    expect(() => assertSafeLoadTarget({ ...baseEnv, LOAD_SUPABASE_URL: 'https://CYFTBFFHGJMSFOGXAWRL.supabase.co/rest/v1' })).toThrow(/PRODUÇÃO/);
  });

  it('exige a confirmação de banco de teste e as variáveis obrigatórias', () => {
    expect(() => assertSafeLoadTarget({ ...baseEnv, LOAD_CONFIRM_TEST_DB: undefined })).toThrow(/LOAD_CONFIRM_TEST_DB/);
    expect(() => assertSafeLoadTarget({ ...baseEnv, LOAD_CRON_SECRET: '' })).toThrow(/LOAD_CRON_SECRET/);
  });

  it('app remoto só com LOAD_ALLOW_REMOTE_APP=true', () => {
    const remote = { ...baseEnv, LOAD_APP_URL: 'https://teste.exemplo.com.br' };
    expect(() => assertSafeLoadTarget(remote)).toThrow(/LOAD_ALLOW_REMOTE_APP/);
    expect(assertSafeLoadTarget({ ...remote, LOAD_ALLOW_REMOTE_APP: 'true' }).appUrl).toBe('https://teste.exemplo.com.br');
    expect(assertSafeLoadTarget({ ...baseEnv, LOAD_APP_URL: 'http://192.168.0.5:3000' }).appUrl).toBe('http://192.168.0.5:3000');
  });
});

describe('parser de métricas do tick', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    created_at: '2026-10-08T10:00:00Z',
    payload: {
      status: 'ok',
      duration_ms: 1200,
      totals: { sent: 100, failed: 2, deferred: 1, not_started: 0 },
      event_loop_lag_p99_ms: 35.5,
      rss_mb: 410,
      rss_peak_mb: 450,
      effective_concurrency: { global_peak_in_flight: 120 },
      provider_errors: { '131056': 2 },
      backoff_events: [{}, {}],
      channels: { c1: { sent: 60, failed: 1, peak_in_flight: 30 }, c2: { sent: 40, failed: 1, peak_in_flight: 25 } },
      ...over,
    },
  });

  it('normaliza uma linha e tolera payload incompleto', () => {
    expect(parseTickRow(row())).toMatchObject({ durationMs: 1200, sent: 100, lagP99Ms: 35.5, rssPeakMb: 450, backoffs: 2 });
    expect(parseTickRow({ created_at: null, payload: null })).toMatchObject({ durationMs: 0, sent: 0, channels: {} });
    expect(parseTickRow(undefined)).toMatchObject({ sent: 0 });
  });

  it('resume p50/p95, totais, pico e erros por canal', () => {
    const rows = [100, 200, 300, 400, 5000].map((ms, i) => row({ duration_ms: ms, totals: { sent: 10 * (i + 1) }, rss_mb: 400 + i }));
    const s = summarizeTicks(rows);
    expect(s.ticks).toBe(5);
    expect(s.sentTotal).toBe(150);
    expect(s.tickP50Ms).toBe(300);
    expect(s.tickP95Ms).toBe(5000);
    expect(s.tickMaxMs).toBe(5000);
    expect(s.providerErrors).toEqual({ '131056': 10 });
    expect((s.perChannel as Record<string, unknown>).c1).toMatchObject({ sent: 300, peakInFlight: 30 });
    expect(s.lagP99MaxMs).toBe(35.5);
  });

  it('percentile e formatTable', () => {
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([], 95)).toBe(0);
    const table = formatTable(['a', 'bb'], [['1', '22'], ['333', '4']]);
    expect(table.split('\n')).toHaveLength(4);
    expect(table).toContain('333');
  });
});

describe('parser de métricas da Meta simulada', () => {
  const snap = (total: number, peak: number, errors: Record<string, number> = {}) => ({
    phones: { p1: { total, ok: total, errors, rps_peak: peak, max_in_flight: 12 } },
  });
  it('envios/s por número a partir das amostras', () => {
    const out = summarizeMock([
      { at: 0, snapshot: snap(0, 0) },
      { at: 5000, snapshot: snap(200, 50, { '429': 3 }) },
      { at: 10_000, snapshot: snap(800, 82, { '429': 7 }) },
    ]);
    expect(out.elapsedS).toBe(10);
    expect((out.phones as Record<string, unknown>).p1).toMatchObject({ requests: 800, avgRps: 80, peakRps: 82, maxInFlight: 12, errors: { '429': 7 } });
    expect(out.totalAvgRps).toBe(80);
  });
  it('sem amostras não quebra', () => {
    expect(summarizeMock([]).totalRequests).toBe(0);
  });
});

describe('Meta simulada (scripts/lib/meta-mock.mjs)', () => {
  let mock: ReturnType<typeof createMetaMock> | null = null;
  afterEach(async () => {
    await mock?.close();
    mock = null;
  });
  const start = async (options: Record<string, unknown> = {}) => {
    mock = createMetaMock({ port: 0, latencyP50Ms: 1, latencyP95Ms: 2, ...options });
    const address = (await mock.listen()) as { port: number };
    return `http://127.0.0.1:${address.port}`;
  };
  const send = (base: string, phone: string, to = '5511999990000') =>
    fetch(`${base}/v21.0/${phone}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template' }),
    });

  it('responde como a Graph API e conta por phone_number_id', async () => {
    const base = await start();
    const a = await send(base, 'num-a');
    expect(a.status).toBe(200);
    const body = await a.json();
    expect(body.messages[0].id).toMatch(/^wamid\.MOCK/);
    expect(body.contacts[0].wa_id).toBe('5511999990000');
    await send(base, 'num-a');
    await send(base, 'num-b');
    const stats = await (await fetch(`${base}/__stats`)).json();
    expect(stats.phones['num-a']).toMatchObject({ total: 2, ok: 2 });
    expect(stats.phones['num-b'].total).toBe(1);
    await fetch(`${base}/__reset`);
    expect(Object.keys((await (await fetch(`${base}/__stats`)).json()).phones)).toHaveLength(0);
  });

  it('injeta erros no formato da Meta (429, 131056, 131026, 5xx)', async () => {
    for (const [key, status, code] of [['429', 429, 130429], ['131056', 400, 131056], ['5xx', 500, 2]] as const) {
      const base = await start({ errorRates: { [key]: 1 } });
      const res = await send(base, 'num-e');
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
      expect((await (await fetch(`${base}/__stats`)).json()).phones['num-e'].errors[key]).toBe(1);
      await mock!.close();
      mock = null;
    }
  });

  it('rejeita corpo sem destinatário', async () => {
    const base = await start();
    const res = await fetch(`${base}/v21.0/p/messages`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(400);
  });

  it('webhooks de status assinados com HMAC do app_secret de teste', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { ok: true } as Response;
    };
    const base = await start({ webhookUrl: 'http://app.local/api/whatsapp/webhook', appSecret: 'segredo-de-teste', readRate: 1, failedRate: 0, outOfOrderRate: 0, duplicateRate: 0, fetchImpl, random: () => 0, statusDelaysMs: { sent: 100, delivered: 200, read: 300 } });
    await send(base, 'num-w', '5511988880000');
    // sent sai em ~200 ms
    await new Promise((r) => setTimeout(r, 450));
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const first = calls[0];
    const expectedSig = `sha256=${createHmac('sha256', 'segredo-de-teste').update(first.body).digest('hex')}`;
    expect(first.headers['X-Hub-Signature-256']).toBe(expectedSig);
    const payload = JSON.parse(first.body);
    const value = payload.entry[0].changes[0].value;
    expect(value.metadata.phone_number_id).toBe('num-w');
    expect(value.statuses[0]).toMatchObject({ status: 'sent', recipient_id: '5511988880000' });
  });

  it('helpers: latência lognormal, taxas de erro e assinatura', () => {
    expect(sampleLatencyMs(300, 1000, () => 0.5)).toBeGreaterThan(0);
    // z = 0 (u2 = 0.25 → cos(π/2) = 0) → exatamente o p50
    expect(sampleLatencyMs(300, 1000, (() => { let i = 0; return () => [0.3678794411714423, 0.25][i++ % 2]; })())).toBe(300);
    expect(sampleLatencyMs(0, 0)).toBe(0);
    expect(parseErrorRates('429=0.01, 131056=0.5,xx=abc,5xx=2')).toEqual({ '429': 0.01, '131056': 0.5, '5xx': 1 });
    expect(pickError({ '429': 0.5, '5xx': 0.5 }, () => 0.1)).toBe('429');
    expect(pickError({ '429': 0.5, '5xx': 0.5 }, () => 0.7)).toBe('5xx');
    expect(pickError({}, () => 0.1)).toBeNull();
    expect(signWebhookBody('abc', 's')).toBe(`sha256=${createHmac('sha256', 's').update('abc').digest('hex')}`);
    expect(buildStatusPayload({ wabaId: 'w', phoneNumberId: 'p', displayPhone: 'd', messageId: 'm', status: 'read', recipient: 'r', now: 5000 }).entry[0].changes[0].value.statuses[0].timestamp).toBe('5');
  });
});
