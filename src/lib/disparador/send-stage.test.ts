import { describe, expect, it, vi } from 'vitest';

// W0: o estágio de envio extraído do cron. A regressão comportamental está nos testes do cron (route.test.ts) e do agendador; aqui só se
// prova que o módulo é chamável de fora do Next (é o que o worker vai fazer) e que o agrupamento por número separa os canais.
vi.mock('@/lib/disparador/processQueue', () => ({ processQueueItem: vi.fn() }));
vi.mock('@/lib/disparador/admin-client', () => ({ supabaseAdmin: () => ({}) }));

import { buildChannelWork, runSendStage, type PlannedCampaign } from './send-stage';
import { TickTelemetry } from './dispatch-telemetry';
import { resolveThroughputConfig } from './throughput-config';

const config = resolveThroughputConfig({});
const campaign = (id: string) => ({ id, account_id: 'ACC', status: 'em_execucao', janela_inicio: '08:00', janela_fim: '18:00', dias_envio: [1], batch_size: 1, batch_pause_seconds: 0, limite_por_hora: null }) as never;
const item = (id: string, session: string, campaignId: string) => ({ id, campaign_id: campaignId, session_id: session, scheduled_at: '2026-10-20T11:00:00Z', tentativas: 0 }) as never;

function dbFor(channels: Array<{ id: string; provider: string; account_id: string }>) {
  const chain = (data: unknown[]) => {
    const c: any = {};
    c.select = () => c;
    c.in = () => c;
    c.then = (resolve: (v: unknown) => void) => resolve({ data, error: null });
    return c;
  };
  return {
    from: (table: string) => chain(table === 'whatsapp_config' ? channels : []),
  } as never;
}

describe('send-stage', () => {
  it('buildChannelWork: um item de trabalho por número, com as campanhas de cada um e telemetria do canal', async () => {
    const planned: PlannedCampaign[] = [
      { campaign: campaign('c1'), items: [item('i1', 'S1', 'c1'), item('i2', 'S2', 'c1')], result: { campaign_id: 'c1', sent: 0, pending_confirmation: 0 } },
      { campaign: campaign('c2'), items: [item('i3', 'S1', 'c2')], result: { campaign_id: 'c2', sent: 0, pending_confirmation: 0 } },
    ];
    const telemetry = new TickTelemetry();
    const work = await buildChannelWork(
      dbFor([
        { id: 'S1', provider: 'meta', account_id: 'ACC' },
        { id: 'S2', provider: 'meta', account_id: 'ACC' },
      ]),
      planned,
      config,
      telemetry,
    );
    expect(work.channels.map((c) => c.channelId).sort()).toEqual(['S1', 'S2']);
    const s1 = work.channels.find((c) => c.channelId === 'S1')!;
    expect(s1.campaigns.map((c) => c.campaignId).sort()).toEqual(['c1', 'c2']);
    expect(work.channels.find((c) => c.channelId === 'S2')!.campaigns).toHaveLength(1);
  });

  it('skipSend (números com worker vivo): o cron pula só o que o worker envia; os demais seguem; ausente = comportamento de sempre', async () => {
    const planned: PlannedCampaign[] = [
      { campaign: campaign('c1'), items: [item('i1', 'S1', 'c1'), item('i2', 'S2', 'c1')], result: { campaign_id: 'c1', sent: 0, pending_confirmation: 0 } },
    ];
    const db = dbFor([
      { id: 'S1', provider: 'meta', account_id: 'ACC' },
      { id: 'S2', provider: 'meta', account_id: 'ACC' },
    ]);
    const skipped = await buildChannelWork(db, planned, config, new TickTelemetry(), (_c, channelId) => channelId === 'S1');
    expect(skipped.channels.map((c) => c.channelId)).toEqual(['S2']);
    const none = await buildChannelWork(db, planned, config, new TickTelemetry(), () => false);
    expect(none.channels.map((c) => c.channelId).sort()).toEqual(['S1', 'S2']);
    const absent = await buildChannelWork(db, planned, config, new TickTelemetry());
    expect(absent.channels).toHaveLength(2);
  });

  it('runSendStage sem nada planejado devolve o relatório do agendador sem lançar', async () => {
    const report = await runSendStage({
      db: dbFor([]),
      planned: [],
      config,
      telemetry: new TickTelemetry(),
      batchMode: false,
      outOfTime: () => false,
      health: undefined,
      autoPauseConfig: { enabled: false, minAttempts: 20 } as never,
    });
    expect(report).toBeTruthy();
    expect(Object.keys(report.channels)).toEqual([]);
  });
});
