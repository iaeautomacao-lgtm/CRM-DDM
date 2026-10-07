// Meta simulada — perfil do audit §4 (latência, falhas, webhooks duplicados/fora de ordem, qualidade, controle em tempo real).
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AUDIT_ERROR_RATES, buildQualityPayload, createMetaMock, sampleLatencyMs } from '../../../scripts/loadtest/lib/meta-mock.mjs';
import { LOADTEST_FORBIDDEN_SUPABASE_REFS as MJS_REFS } from '../../../scripts/loadtest/lib/forbidden.mjs';
import { LOADTEST_FORBIDDEN_SUPABASE_REFS } from '../loadtest/gate';

describe('Meta simulada — perfil do audit §4', () => {
  let mock: ReturnType<typeof createMetaMock> | null = null;
  afterEach(async () => {
    await mock?.close();
    mock = null;
  });
  const start = async (options: Record<string, unknown> = {}) => {
    mock = createMetaMock({ port: 0, latencyP50Ms: 1, latencyP95Ms: 2, ...options });
    return `http://127.0.0.1:${((await mock.listen()) as { port: number }).port}`;
  };
  const send = (base: string, phone: string) =>
    fetch(`${base}/v21.0/${phone}/messages`, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', to: '5511999990000' }) });
  const collect = () => {
    const calls: Array<{ headers: Record<string, string>; body: string }> = [];
    const fetchImpl = async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.push({ headers: init.headers, body: init.body });
      return { ok: true } as Response;
    };
    return { calls, fetchImpl };
  };
  const statusesOf = (calls: Array<{ body: string }>) =>
    calls.map((c) => JSON.parse(c.body).entry[0].changes[0].value.statuses[0] as { status: string; errors?: Array<{ code: number }> });

  it('perfil padrão: p50 ≈ 850 ms / p95 ≈ 1000 ms e taxas do audit', () => {
    expect(AUDIT_ERROR_RATES).toEqual({ '5xx': 0.01, 429: 0.005, 131056: 0.002, async_131026: 0.003, timeout: 0.005 });
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const samples = Array.from({ length: 20_000 }, () => sampleLatencyMs(850, 1000, rnd)).sort((a, b) => a - b);
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p50).toBeGreaterThan(800);
    expect(p50).toBeLessThan(900);
    expect(p95).toBeGreaterThan(900);
    expect(p95).toBeLessThan(1100);
  });

  it('timeout: não responde (segura a conexão além do timeout do cliente)', async () => {
    const base = await start({ errorRates: { timeout: 1 }, timeoutHoldMs: 400 });
    const res = await fetch(`${base}/v21.0/p-t/messages`, {
      method: 'POST',
      body: JSON.stringify({ to: '5511999990000' }),
      signal: AbortSignal.timeout(150),
    }).catch((e) => e);
    expect(res).toBeInstanceOf(Error);
    expect((await (await fetch(`${base}/__stats`)).json()).phones['p-t'].errors.timeout).toBe(1);
  });

  it('131026 assíncrono: aceita o envio (200) e depois manda status failed com código 131026', async () => {
    const { calls, fetchImpl } = collect();
    const base = await start({
      errorRates: { async_131026: 1 },
      webhookUrl: 'http://app/webhook',
      fetchImpl,
      statusDelaysMs: { sent: 10, delivered: 30, read: 60 },
      outOfOrderRate: 0,
      duplicateRate: 0,
      random: (() => {
        let i = 0;
        return () => [0.5, 0.9][i++ % 2];
      })(),
    });
    const res = await send(base, 'p-a');
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    const statuses = statusesOf(calls);
    expect(statuses.map((s) => s.status)).toEqual(['sent', 'failed']);
    expect(statuses[1].errors?.[0].code).toBe(131026);
  });

  it('duplicados e fora de ordem acontecem quando a taxa é 100%', async () => {
    const { calls, fetchImpl } = collect();
    const base = await start({
      webhookUrl: 'http://app/webhook',
      fetchImpl,
      statusDelaysMs: { sent: 40, delivered: 10, read: 80 },
      readRate: 0,
      failedRate: 0,
      duplicateRate: 1,
      outOfOrderRate: 1,
      random: () => 0,
    });
    await send(base, 'p-d');
    await new Promise((r) => setTimeout(r, 250));
    const statuses = statusesOf(calls).map((s) => s.status);
    expect(statuses).toHaveLength(4); // sent e delivered, cada um duplicado
    expect(statuses.filter((s) => s === 'sent')).toHaveLength(2);
    const snap = mock!.snapshot();
    expect(snap.webhooks.duplicates).toBe(2);
    expect(snap.webhooks.outOfOrder).toBe(1);
  });

  it('/__control: latência por número, taxas de erro e phone_number_quality_update assinado', async () => {
    const { calls, fetchImpl } = collect();
    const base = await start({ webhookUrl: 'http://app/webhook', appSecret: 's3', fetchImpl });
    const set = await fetch(`${base}/__control`, {
      method: 'POST',
      body: JSON.stringify({ phoneLatency: { lento: { p50: 5, p95: 6 } }, errorRates: { '429': 1 }, quality: { phone: 'lento', event: 'FLAGGED' } }),
    });
    expect((await set.json()).phone_latency.lento.p50).toBe(5);
    expect((await send(base, 'qualquer')).status).toBe(429);
    await new Promise((r) => setTimeout(r, 30));
    const q = calls.find((c) => JSON.parse(c.body).entry[0].changes[0].field === 'phone_number_quality_update');
    expect(q).toBeTruthy();
    expect(JSON.parse(q!.body).entry[0].changes[0].value).toMatchObject({ event: 'FLAGGED' });
    expect(q!.headers['X-Hub-Signature-256']).toBe(`sha256=${createHmac('sha256', 's3').update(q!.body).digest('hex')}`);
    expect(buildQualityPayload({ wabaId: 'w', phoneNumberId: 'p', event: 'UPGRADE' }).entry[0].changes[0].field).toBe('phone_number_quality_update');
  });

  it('a lista de refs proibidos do script e a do app são a mesma e incluem a produção', () => {
    expect([...MJS_REFS].sort()).toEqual([...LOADTEST_FORBIDDEN_SUPABASE_REFS].sort());
    expect(MJS_REFS).toContain('cyftbffhgjmsfogxawrl');
  });
});
