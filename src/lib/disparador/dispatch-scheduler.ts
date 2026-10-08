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
// - backoff adaptativo (só desce):
//   * rate limit real corta o número imediatamente;
//   * 5xx/timeout/rede só cortam quando viram um padrão recorrente;
//   * cada número sofre no máximo 1 redução por tick;
//   * event loop lento ou RSS alto continuam podendo reduzir o teto global.
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
  /**
   * Limite de inícios por segundo do número (P1-4, token bucket com rajada de 1 s). Ausente/0 = sem limite por segundo (comportamento
   * antigo: só as vagas). As vagas continuam sendo o teto de paralelismo. Estado só dentro do tick.
   */
  ratePerSecond?: number;
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
      /** "recovered": saúde normalizou por janelas seguidas e as vagas voltaram (parcial ou total). */
      reason: "event_loop_lag" | "rss" | "recovered";
      value: number;
      atMs: number;
      from: number;
      to: number;
    };

export interface SchedulerOptions<T> {
  channels: ReadonlyArray<ChannelWork<T>>;
  globalConcurrency: number;
  shouldStop: () => boolean;
  /** `slotsFree`: vagas livres do número/global no momento do início (inclui a desta tarefa) — dimensiona o claim em lote. */
  run: (item: T, ctx: { channelId: string; campaignId: string; slotsFree: number }) => Promise<TaskOutcome | void>;
  adaptiveBackoff?: boolean;
  /** Lido no máximo a cada `healthCheckIntervalMs`, após um envio terminar. */
  sampleHealth?: () => HealthSample;
  healthCheckIntervalMs?: number;
  /** Janelas SEGUIDAS acima do limite antes de cortar as vagas (histerese; padrão 3). */
  breachWindows?: number;
  /** Janelas SEGUIDAS saudáveis antes de devolver vagas cortadas (padrão 3). */
  recoverWindows?: number;
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
  /** Limite por segundo aplicado ao número neste tick (null = sem limite). */
  ratePerSecond?: number | null;
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
  /** Token bucket do número (null = sem limite por segundo). */
  bucket: { rate: number; capacity: number; tokens: number; lastMs: number } | null;
  /** Uma redução por número/tick evita 24→12→6 por dois erros quase simultâneos. */
  backoffApplied: boolean;
  /** Janela móvel das conclusões recentes: true = 5xx/timeout/rede. */
  transientWindow: boolean[];
  transientCount: number;
}

const MAX_RECORDED_EVENTS = 50;
// Erro transitório isolado é ruído do provedor, não sinal de saturação.
// Só reduzimos se houver um pequeno padrão recorrente na janela recente.
const TRANSIENT_BACKOFF_WINDOW = 300;
const TRANSIENT_BACKOFF_MIN_SAMPLES = 20;
const TRANSIENT_BACKOFF_MIN_SIGNALS = 3;
const TRANSIENT_BACKOFF_MIN_RATE = 0.01;

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
  // F11: um pico isolado de lag (GC, JSON grande) não pode cortar as vagas pela metade. Exige janelas seguidas acima do limite,
  // nunca desce abaixo de 25% das vagas iniciais e devolve as vagas (em passos) quando a saúde normaliza dentro do tick.
  const breachWindows = Math.max(1, Math.floor(options.breachWindows ?? 3));
  const recoverWindows = Math.max(1, Math.floor(options.recoverWindows ?? 3));
  const globalFloor = Math.max(1, Math.ceil(globalStart * 0.25));
  let breachStreak = 0;
  let healthyStreak = 0;
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
      bucket:
        typeof channel.ratePerSecond === "number" && Number.isFinite(channel.ratePerSecond) && channel.ratePerSecond > 0
          ? { rate: channel.ratePerSecond, capacity: Math.max(1, channel.ratePerSecond), tokens: Math.max(1, channel.ratePerSecond), lastMs: now() }
          : null,
      backoffApplied: false,
      transientWindow: [],
      transientCount: 0,
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

  // Token bucket por número: tokens = min(capacidade, tokens + Δt·rate). Sem token, o número espera (o pump reagenda um timer curto).
  const hasToken = (channel: ChannelState<T>): boolean => {
    const bucket = channel.bucket;
    if (!bucket) return true;
    const at = now();
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + Math.max(0, at - bucket.lastMs) * (bucket.rate / 1000));
    bucket.lastMs = at;
    return bucket.tokens >= 1;
  };
  const hasWork = (channel: ChannelState<T>) =>
    channel.queues.some((queue) => !pausedCampaigns.has(queue.campaignId) && queue.next < queue.items.length);
  // Quanto falta (ms) para o próximo token do número que tem trabalho e vaga mas está sem token; teto de 1 s para o shouldStop ser reavaliado.
  const nextTokenWaitMs = (): number | null => {
    let wait: number | null = null;
    for (const channel of channels) {
      const bucket = channel.bucket;
      if (!bucket || channel.inFlight >= channel.cap || !hasWork(channel) || bucket.tokens >= 1) continue;
      const ms = Math.ceil(((1 - bucket.tokens) / bucket.rate) * 1000);
      wait = wait === null ? ms : Math.min(wait, ms);
    }
    return wait === null ? null : Math.min(1000, Math.max(1, wait));
  };

  // Próximo número com vaga e trabalho, a partir do cursor (round-robin).
  const pickChannel = (): ChannelState<T> | null => {
    for (let offset = 0; offset < channels.length; offset++) {
      const index = (channelCursor + offset) % channels.length;
      const channel = channels[index];
      if (channel.inFlight < channel.cap && hasToken(channel) && channel.queues.some(
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

  const registerTransientSample = (channel: ChannelState<T>, isTransient: boolean) => {
    channel.transientWindow.push(isTransient);
    if (isTransient) channel.transientCount++;
    if (channel.transientWindow.length > TRANSIENT_BACKOFF_WINDOW) {
      const removed = channel.transientWindow.shift();
      if (removed) channel.transientCount--;
    }
  };

  const shouldBackoffChannel = (channel: ChannelState<T>, reason: BackoffReason | null): BackoffReason | null => {
    if (!adaptive || channel.backoffApplied) return null;

    // 429/130429/131048/131056 etc. são sinais explícitos de limite:
    // reação imediata, mas apenas uma vez neste tick.
    if (reason === "rate_limit") return reason;

    const isTransient = reason === "server_error" || reason === "timeout" || reason === "network";
    registerTransientSample(channel, isTransient);

    // Avaliamos apenas quando esta conclusão trouxe um novo sinal transitório.
    // Assim 2 erros em 1.218 chamadas, como no incidente real, ficam só na
    // telemetria e não acionam freio/cooldown.
    if (!isTransient) return null;

    const samples = channel.transientWindow.length;
    if (samples < TRANSIENT_BACKOFF_MIN_SAMPLES) return null;
    if (channel.transientCount < TRANSIENT_BACKOFF_MIN_SIGNALS) return null;
    if (channel.transientCount / samples < TRANSIENT_BACKOFF_MIN_RATE) return null;
    return reason;
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
    if (!reason) {
      breachStreak = 0;
      healthyStreak++;
      if (globalCap < globalStart && healthyStreak >= recoverWindows) {
        // Devolve 50% das vagas cortadas por vez (nunca passa do início).
        const from = globalCap;
        globalCap = Math.min(globalStart, globalCap + Math.max(1, Math.ceil((globalStart - globalCap) / 2)));
        healthyStreak = 0;
        record({ scope: "global", reason: "recovered", value: sample.eventLoopLagP99Ms, atMs: at, from, to: globalCap });
      }
      return;
    }
    healthyStreak = 0;
    breachStreak++;
    if (breachStreak < breachWindows) return;
    breachStreak = 0;
    const from = globalCap;
    globalCap = Math.max(globalFloor, Math.floor(globalCap / 2));
    if (globalCap === from) return; // já no piso: nada a registrar
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
          ratePerSecond: channel.bucket ? channel.bucket.rate : null,
        };
      }
      report.stoppedEarly = (stopped || pausedCampaigns.size > 0) && report.notStarted > 0;
      resolve(report);
    };

    let wakeTimer: ReturnType<typeof setTimeout> | null = null;
    const pump = () => {
      if (!stopped && options.shouldStop()) stopped = true;
      while (!stopped && globalInFlight < globalCap) {
        const channel = pickChannel();
        if (!channel) break;
        const next = takeNext(channel);
        if (!next) break;
        start(channel, next.campaignId, next.item);
      }
      // Sem token em algum número com trabalho: acorda quando o próximo token cair (vive só durante o tick).
      if (!stopped && !wakeTimer) {
        const wait = nextTokenWaitMs();
        if (wait !== null) {
          wakeTimer = setTimeout(() => {
            wakeTimer = null;
            pump();
          }, wait);
          wakeTimer.unref?.();
        }
      }
      if (stopped && wakeTimer) {
        clearTimeout(wakeTimer);
        wakeTimer = null;
      }
      if (globalInFlight === 0 && !wakeTimer) finish();
    };

    const start = (channel: ChannelState<T>, campaignId: string, item: T) => {
      channel.inFlight++;
      channel.started++;
      channel.peak = Math.max(channel.peak, channel.inFlight);
      globalInFlight++;
      globalPeak = Math.max(globalPeak, globalInFlight);
      started++;
      if (channel.bucket) channel.bucket.tokens -= 1;
      // Vagas livres para o claim em lote (#137), limitadas também pelos tokens do limite/s do número:
      // não reservar mais itens do que o número pode iniciar agora.
      const slotsFree = Math.max(1, Math.min(
        channel.cap - channel.inFlight + 1,
        globalCap - globalInFlight + 1,
        channel.bucket ? Math.floor(channel.bucket.tokens) + 1 : Number.POSITIVE_INFINITY,
      ));
      let outcome: TaskOutcome | void = undefined;
      Promise.resolve()
        .then(() => options.run(item, { channelId: channel.channelId, campaignId, slotsFree }))
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
          const reason = outcome ? outcome.backoff ?? null : null;
          const appliedReason = shouldBackoffChannel(channel, reason);
          if (appliedReason) {
            const from = channel.cap;
            channel.cap = Math.max(1, Math.floor(channel.cap / 2));
            channel.backoffApplied = true;
            record({
              scope: "channel",
              channelId: channel.channelId,
              reason: appliedReason,
              atMs: now(),
              from,
              to: channel.cap,
            });
          }
          checkHealth();
          pump();
        });
    };

    pump();
  });
}
