import { describe, expect, it } from 'vitest';

import { drainClaimLatencies, recordClaimLatency, timedClaim } from './claim-latency';
import { TickTelemetry } from './dispatch-telemetry';
import { resolveThroughputConfig } from './throughput-config';

const payloadOf = (telemetry: TickTelemetry) =>
  telemetry.buildPayload({
    durationMs: 1000,
    status: 'processed',
    config: resolveThroughputConfig({}),
    campaigns: 1,
    schedule: null,
    health: { eventLoopLagP99Ms: 1, rssMb: 100, rssPeakMb: 100 },
  });

describe('latência do claim no cron_tick', () => {
  it('timedClaim registra a duração com sucesso e com falha, e devolve/propaga o resultado', async () => {
    drainClaimLatencies();
    expect(await timedClaim(async () => 'ok')).toBe('ok');
    await expect(timedClaim(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    const samples = drainClaimLatencies();
    expect(samples).toHaveLength(2);
    expect(samples.every((ms) => ms >= 0)).toBe(true);
    expect(drainClaimLatencies()).toEqual([]);
  });

  it('ignora valores inválidos', () => {
    drainClaimLatencies();
    recordClaimLatency(Number.NaN);
    recordClaimLatency(-1);
    expect(drainClaimLatencies()).toEqual([]);
  });

  it('o payload do tick traz claim_ms (contagem, média, p95 e máximo) só do próprio tick', () => {
    recordClaimLatency(900); // de um tick anterior: o novo TickTelemetry zera
    const telemetry = new TickTelemetry();
    for (const ms of [2, 3, 4, 5, 6, 7, 8, 9, 10, 40]) recordClaimLatency(ms);
    const payload = payloadOf(telemetry) as { claim_ms: { count: number; avg_ms: number; p95_ms: number; max_ms: number } };
    expect(payload.claim_ms).toEqual({ count: 10, avg_ms: 9, p95_ms: 40, max_ms: 40 });
    expect((payloadOf(new TickTelemetry()) as { claim_ms: { count: number } }).claim_ms.count).toBe(0);
  });
});
