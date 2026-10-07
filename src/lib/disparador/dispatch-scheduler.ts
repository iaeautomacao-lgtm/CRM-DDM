import type { BackoffReason } from "@/lib/disparador/provider-signals";

// ============================================================
// Agendador do tick do disparador, por NÚMERO (session_id).
//
// Entrada: uma fila por número, com os candidatos de cada campanha que usa
// aquele número (na ordem do SELECT do cron). O agendador:
// - roda os números em paralelo;
// - dentro de um número, até `maxConcurrency` envios simultâneos;
// - alterna as campanhas de um mesmo número (round-robin), para uma
//   campanha grande não segurar as outras;
// - limita o total em andamento no processo a `globalConcurrency`,
//   repartindo as vagas entre números também em round-robin;
// - não começa trabalho novo quando `shouldStop()` (orçamento do tick
//   esgotado ou lease do lock perdido); o que já começou termina;
// - backoff adaptativo (só desce): sinal de limite/erro do provedor corta
//   pela metade a concorrência daquele número pelo resto do tick; event
//   loop lento ou RSS alto corta pela metade a concorrência global.
//
// Não envia nada: `run` é o processQueueItem do cron (claim atômico, quota,
// blacklist, bifurcação Meta/WAHA continuam lá).
//
// Com 1 campanha em 1 número, a ordem de início dos itens e o número de
// envios simultâneos são idênticos ao processWithConcurrency(items, 4)
// anterior.
// ============================================================

export interface ChannelWork<T> {
  channelId: string;
  /** Concorrência inicial do número (já resolvida, >= 1). */
  maxConcurrency: number;
  campaigns: Array<{ campaignId: string; items: readonly T[] }>;
}

export interface TaskOutcome {
  backoff?: BackoffReason | null;
  /** Pausa confirmada no banco: não iniciar mais itens desta campanha. */
  pauseCampaign?: boolean;
}

export interface HealthSample {
  eventLoopLagP99Ms: number;
  rssMb: number;
}

export type BackoffEvent =
  | {
      scope: "channel";
      channelId: string;
      reason: BackoffReason;
      atMs: number;
      from: number;
      to: number;
    }
  | {
      scope: "global";
      reason: "event_loop_lag" | "rss";
      value: number;
      atMs: number;
      from: number;
      to: number;
    };

export interface SchedulerOptions<T> {
  channels: ReadonlyArray<ChannelWork<T>>;
  globalConcurrency: number;
  shouldStop: () => boolean;
  run: (item: T, ctx: { channelId: string; campaignId: string }) => Promise<TaskOutcome | void>;
  adaptiveBackoff?: boolean;
  /** Lido no máximo a cada `healthCheckIntervalMs`, após um envio terminar. */
  sampleHealth?: () => HealthSample;
  healthCheckIntervalMs?: number;
  maxEventLoopLagMs?: number;
  maxRssMb?: number;
  onBackoff?: (event: BackoffEvent) => void;
  now?: () => number;
}

export interface ChannelReport {
  started: number;
  notStarted: number;
  peakInFlight: number;
  capStart: number;
  capEnd: number;
}

export interface SchedulerReport {
  started: number;
  notStarted: number;
  /** true se sobrou trabalho porque shouldStop() virou true. */
  stoppedEarly: boolean;
  globalStart: number;
  globalEnd: number;
  globalPeakInFlight: number;
  channels: Record<string, ChannelReport>;
  backoffEvents: BackoffEvent[];
}

interface CampaignQueue<T> {
  campaignId: string;
  items: readonly T[];
  next: number;
}

interface ChannelState<T> {
  channelId: string;
  cap: number;
  capStart: number;
  inFlight: number;
  peak: number;
  started: number;
  cursor: number;
  queues: CampaignQueue<T>[];
}

const MAX_RECORDED_EVENTS = 50;

function positiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}

function pendingOf<T>(channel: ChannelState<T>): number {
  return channel.queues.reduce((sum, queue) => sum + (queue.items.length - queue.next), 0);
}

export function runDispatchSchedule<T>(options: SchedulerOptions<T>): Promise<SchedulerReport> {
  const now = options.now ?? Date.now;
  const adaptive = options.adaptiveBackoff ?? true;
  const healthInterval = options.healthCheckIntervalMs ?? 1_000;
  const globalStart = positiveInt(options.globalConcurrency, "globalConcurrency");
  let globalCap = globalStart;
  let globalInFlight = 0;
  let globalPeak = 0;
  let started = 0;
  let stopped = false;
  let channelCursor = 0;
  let lastHealthAt = now();
  const events: BackoffEvent[] = [];
  const pausedCampaigns = new Set<string>();

  const channels: ChannelState<T>[] = options.channels.map((channel) => {
    const cap = positiveInt(channel.maxConcurrency, "maxConcurrency");
    return {
      channelId: channel.channelId,
      cap,
      capStart: cap,
      inFlight: 0,
      peak: 0,
      started: 0,
      cursor: 0,
      queues: channel.campaigns.map((campaign) => ({
        campaignId: campaign.campaignId,
        items: campaign.items,
        next: 0,
      })),
    };
  });

  const record = (event: BackoffEvent) => {
    if (events.length < MAX_RECORDED_EVENTS) events.push(event);
    try {
      options.onBackoff?.(event);
    } catch (error) {
      console.error("[Disparador] onBackoff falhou:", error);
    }
  };

  // Próximo número com vaga e trabalho, a partir do cursor (round-robin).
  const pickChannel = (): ChannelState<T> | null => {
    for (let offset = 0; offset < channels.length; offset++) {
      const index = (channelCursor + offset) % channels.length;
      const channel = channels[index];
      if (channel.inFlight < channel.cap && channel.queues.some(
        (queue) => !pausedCampaigns.has(queue.campaignId) && queue.next < queue.items.length
      )) {
        channelCursor = (index + 1) % channels.length;
        return channel;
      }
    }
    return null;
  };

  // Próximo item do número, alternando as campanhas (round-robin).
  const takeNext = (channel: ChannelState<T>): { campaignId: string; item: T } | null => {
    for (let offset = 0; offset < channel.queues.length; offset++) {
      const index = (channel.cursor + offset) % channel.queues.length;
      const queue = channel.queues[index];
      if (!pausedCampaigns.has(queue.campaignId) && queue.next < queue.items.length) {
        channel.cursor = (index + 1) % channel.queues.length;
        return { campaignId: queue.campaignId, item: queue.items[queue.next++] };
      }
    }
    return null;
  };

  const checkHealth = () => {
    if (!adaptive || !options.sampleHealth) return;
    const at = now();
    if (at - lastHealthAt < healthInterval) return;
    lastHealthAt = at;
    let sample: HealthSample;
    try {
      sample = options.sampleHealth();
    } catch {
      return;
    }
    const lagLimit = options.maxEventLoopLagMs ?? Number.POSITIVE_INFINITY;
    const rssLimit = options.maxRssMb ?? Number.POSITIVE_INFINITY;
    const reason =
      sample.eventLoopLagP99Ms > lagLimit ? "event_loop_lag" : sample.rssMb > rssLimit ? "rss" : null;
    if (!reason) return;
    const from = globalCap;
    globalCap = Math.max(1, Math.floor(globalCap / 2));
    record({
      scope: "global",
      reason,
      value: reason === "rss" ? sample.rssMb : sample.eventLoopLagP99Ms,
      atMs: at,
      from,
      to: globalCap,
    });
  };

  return new Promise<SchedulerReport>((resolve) => {
    const finish = () => {
      const report: SchedulerReport = {
        started,
        notStarted: 0,
        stoppedEarly: false,
        globalStart,
        globalEnd: globalCap,
        globalPeakInFlight: globalPeak,
        channels: {},
        backoffEvents: events,
      };
      for (const channel of channels) {
        const notStarted = pendingOf(channel);
        report.notStarted += notStarted;
        report.channels[channel.channelId] = {
          started: channel.started,
          notStarted,
          peakInFlight: channel.peak,
          capStart: channel.capStart,
          capEnd: channel.cap,
        };
      }
      report.stoppedEarly = (stopped || pausedCampaigns.size > 0) && report.notStarted > 0;
      resolve(report);
    };

    const pump = () => {
      if (!stopped && options.shouldStop()) stopped = true;
      while (!stopped && globalInFlight < globalCap) {
        const channel = pickChannel();
        if (!channel) break;
        const next = takeNext(channel);
        if (!next) break;
        start(channel, next.campaignId, next.item);
      }
      if (globalInFlight === 0) finish();
    };

    const start = (channel: ChannelState<T>, campaignId: string, item: T) => {
      channel.inFlight++;
      channel.started++;
      channel.peak = Math.max(channel.peak, channel.inFlight);
      globalInFlight++;
      globalPeak = Math.max(globalPeak, globalInFlight);
      started++;
      let outcome: TaskOutcome | void = undefined;
      Promise.resolve()
        .then(() => options.run(item, { channelId: channel.channelId, campaignId }))
        .then(
          (result) => {
            outcome = result;
          },
          (error) => {
            // Quem chama já trata as próprias exceções; isto só impede que
            // um erro inesperado derrube o lote inteiro.
            console.error("[Disparador] Tarefa do agendador falhou:", error);
          }
        )
        .finally(() => {
          channel.inFlight--;
          globalInFlight--;
          if (outcome?.pauseCampaign) pausedCampaigns.add(campaignId);
          const reason = outcome ? outcome.backoff : null;
          if (adaptive && reason) {
            const from = channel.cap;
            channel.cap = Math.max(1, Math.floor(channel.cap / 2));
            record({ scope: "channel", channelId: channel.channelId, reason, atMs: now(), from, to: channel.cap });
          }
          checkHealth();
          pump();
        });
    };

    pump();
  });
}
