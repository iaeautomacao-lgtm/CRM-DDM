// Estágio de ENVIO do disparador, extraído de /api/disparador/cron (W0 do worker, desenho em prd-v2/disparador-4800-pronto.md):
// o MESMO código roda no tick do cron e no processo worker. Aqui ficam o agrupamento dos candidatos por número (buildChannelWork:
// limites, cooldown, limite/s por qualidade, vagas derivadas), o agendador por número (round-robin entre campanhas, justiça entre números),
// o claim em lote, a confirmação em micro-lote e a autopausa. O planejamento (janela, cadência, reflow, encerramento) fica fora: quem chama
// entrega as campanhas já planejadas. Movido sem mudança de comportamento.
import type { SupabaseClient } from "@supabase/supabase-js";
import { processQueueItem, type QueueItem, type Campaign } from "@/lib/disparador/processQueue";
import { runDispatchSchedule, type ChannelWork, type SchedulerReport } from "@/lib/disparador/dispatch-scheduler";
import type { TickTelemetry, startHealthMonitor } from "@/lib/disparador/dispatch-telemetry";
import type { BackoffReason } from "@/lib/disparador/provider-signals";
import {
  isInCooldown,
  MAX_PER_NUMBER_CONCURRENCY,
  rememberCooldown,
  resolveChannelConcurrency,
  type DispatchProvider,
  type ThroughputConfig,
} from "@/lib/disparador/throughput-config";
import { channelConfigFor, preloadBlacklist, queueItemPrimaryPhone } from "@/lib/disparador/tick-preload";
import { checkCampaignAutoPause, type autoPauseConfigFromEnv } from "@/lib/disparador/auto-pause";
import { ChannelClaimer, isClaimToken } from "@/lib/disparador/batch-claim";
import { ConfirmBatcher, registerShutdownDrain, singleConfirm } from "@/lib/disparador/confirm-batcher";
import { derivedSlots, effectiveRate, policyFromRow, type RateState } from "@/lib/disparador/channel-rate";
import { DEFAULT_WAHA_RATE_PER_SECOND, loadWahaRates } from "@/lib/disparador/waha-rate";
import { trackSend } from "@/lib/disparador/shutdown-gate";

export type AdminDb = SupabaseClient;

export interface PlannedCampaign {
  campaign: Campaign;
  items: QueueItem[];
  result: { campaign_id: string; sent: number; pending_confirmation: number };
}


// Agrupa os candidatos por número (session_id), na ordem das campanhas
// (mais atrasadas primeiro) e, dentro de cada uma, na ordem do SELECT.
// Resolve a concorrência de cada número: linha de dispatch_channel_limits
// > padrão do provedor (env); cooldown recente → metade.
// P1-4: p95 da latência da Meta usado para derivar as vagas do limite/s (vagas = ceil(rate × p95 × 1,2)).
function assumedP95Seconds(): number {
  const parsed = Number(process.env.DISPARADOR_ASSUMED_P95_S);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 30) : 1;
}

export async function buildChannelWork(
  db: AdminDb,
  planned: PlannedCampaign[],
  config: ThroughputConfig,
  telemetry: TickTelemetry
): Promise<{
  channels: ChannelWork<QueueItem>[];
  defaultMaxInFlight: Map<string, number | undefined>;
  /** Linhas de whatsapp_config do tick; null se a leitura falhou (cada envio lê). */
  configs: Map<string, Record<string, any>> | null;
}> {
  const byChannel = new Map<string, Map<string, QueueItem[]>>();
  const rateRows = new Map<string, Record<string, any>>();
  for (const entry of planned) {
    for (const item of entry.items) {
      const channelId = item.session_id ?? "";
      let campaigns = byChannel.get(channelId);
      if (!campaigns) byChannel.set(channelId, (campaigns = new Map()));
      let list = campaigns.get(entry.campaign.id);
      if (!list) campaigns.set(entry.campaign.id, (list = []));
      list.push(item);
    }
  }
  const ids = [...byChannel.keys()].filter(Boolean);
  const info = new Map<string, { provider: DispatchProvider | null; maxInFlight: number | null; cooldownUntil: string | null; paused: boolean }>();
  let configs: Map<string, Record<string, any>> | null = new Map();
  if (ids.length) {
    const [providers, limits, cooldowns, rates] = await Promise.all([
      // Linha inteira: o envio usa esta leitura (uma por tick) em vez de
      // ler o canal a cada item.
      db.from("whatsapp_config").select("*").in("id", ids),
      db.from("dispatch_channel_limits").select("*").in("session_id", ids),
      // Tabela da migration 164; sem ela, só vale o cooldown em memória.
      db.from("dispatch_channel_cooldowns").select("session_id, cooldown_until").in("session_id", ids),
      // Migration 190 (P1-4): limite por segundo por número. Sem a tabela/linha, o número segue só com as vagas (comportamento antigo).
      db.from("dispatch_channel_rate").select("*").in("session_id", ids),
    ]);
    if (rates.error) {
      console.warn("[Cron] dispatch_channel_rate indisponível; sem limite por segundo:", rates.error.message);
    } else {
      for (const row of (rates.data ?? []) as Array<Record<string, any> & { session_id: string }>) rateRows.set(row.session_id, row);
    }
    if (providers.error) {
      console.error("[Cron] Falha ao ler provedores dos canais:", providers.error.message);
      configs = null;
    }
    if (limits.error) console.error("[Cron] Falha ao ler limites dos canais:", limits.error.message);
    for (const id of ids) info.set(id, { provider: null, maxInFlight: null, cooldownUntil: null, paused: false });
    for (const row of (providers.data ?? []) as Array<Record<string, any> & { id: string; provider: string | null }>) {
      configs?.set(row.id, row);
      const entry = info.get(row.id);
      if (entry && (row.provider === "meta" || row.provider === "waha")) entry.provider = row.provider;
    }
    for (const row of (limits.data ?? []) as Array<{ session_id: string; max_in_flight: number | null; paused?: boolean | null }>) {
      const entry = info.get(row.session_id);
      if (entry) {
        entry.maxInFlight = row.max_in_flight ?? null;
        // Migration 192: número pausado no front não recebe trabalho (o claim também recusa no banco).
        entry.paused = row.paused === true;
      }
    }
    for (const row of (cooldowns.data ?? []) as Array<{ session_id: string; cooldown_until: string | null }>) {
      const entry = info.get(row.session_id);
      if (entry) entry.cooldownUntil = row.cooldown_until;
    }
  }
  // Ritmo do WAHA (migration 338, item 20 de 13/10): limite/s por sessão; sem linha (ou sem a tabela) vale o padrão conservador de 1/s.
  const wahaRates = await loadWahaRates(
    db,
    ids.filter((id) => info.get(id)?.provider === "waha"),
  );
  // Política (% por cor, rampa, teto) por conta dos canais deste tick; ausente = padrão do dono.
  const policyByAccount = new Map<string, Record<string, unknown>>();
  if (rateRows.size && configs) {
    const accountIds = [...new Set([...rateRows.keys()].map((id) => configs?.get(id)?.account_id).filter(Boolean))] as string[];
    if (accountIds.length) {
      const policies = await db.from("dispatch_rate_policy").select("*").in("account_id", accountIds);
      if (!policies.error) for (const row of (policies.data ?? []) as Array<Record<string, unknown> & { account_id: string }>) policyByAccount.set(row.account_id, row);
    }
  }
  const now = Date.now();
  const channels: ChannelWork<QueueItem>[] = [];
  const defaultMaxInFlight = new Map<string, number | undefined>();
  for (const [channelId, campaigns] of byChannel) {
    const channelInfo = info.get(channelId);
    if (channelInfo?.paused) continue;
    const provider = channelInfo?.provider ?? null;
    const inCooldown = isInCooldown(channelId, now, channelInfo?.cooldownUntil);
    let maxConcurrency = resolveChannelConcurrency({
      provider,
      rowMaxInFlight: channelInfo?.maxInFlight,
      inCooldown,
      config,
    });
    // Limite por segundo (P1-4): só Meta e só com linha em dispatch_channel_rate; efetivo = manual ?? auto (rampa, trava, cooldown).
    // As vagas passam a ser DERIVADAS do limite/s (ceil(rate × p95 × 1,2)), limitadas ao teto do número.
    let ratePerSecond: number | undefined;
    // Só a Meta deriva as vagas do limite/s; o WAHA mantém as vagas de sempre e só ganha o balde de fichas (abaixo).
    let slotsFromRate = false;
    const rateRow = provider === "waha" ? undefined : rateRows.get(channelId);
    if (provider === "waha") {
      ratePerSecond = wahaRates.get(channelId) ?? DEFAULT_WAHA_RATE_PER_SECOND;
    } else if (rateRow) {
      const accountId = configs?.get(channelId)?.account_id as string | undefined;
      const policy = policyFromRow(accountId ? policyByAccount.get(accountId) : null);
      const effective = effectiveRate(rateRow as RateState, policy, now, { inCooldown });
      ratePerSecond = effective.rate;
      slotsFromRate = true;
      maxConcurrency = derivedSlots(effective.rate, assumedP95Seconds(), channelInfo?.maxInFlight ?? MAX_PER_NUMBER_CONCURRENCY);
    }
    // Sem linha no banco, o claim usa o padrão do provedor como teto
    // atômico (claim_dispatch_item_capped); com linha, vale a linha.
    defaultMaxInFlight.set(
      channelId,
      channelInfo?.maxInFlight ? undefined : slotsFromRate ? maxConcurrency : config.perNumber[provider ?? "unknown"]
    );
    telemetry.channel(channelId, provider, inCooldown);
    channels.push({
      channelId,
      maxConcurrency,
      ratePerSecond,
      campaigns: [...campaigns].map(([campaignId, items]) => ({ campaignId, items })),
    });
  }
  return { channels, defaultMaxInFlight, configs };
}



// Amostra dos itens vencidos mais antigos (sem OFFSET, sem contatos): só para o detector de reflow no caminho em lote (188).
export async function fetchDueSample(db: AdminDb, campaignId: string, limit = 200): Promise<QueueItem[]> {
  const { data, error } = await db
    .from("disp_message_queue")
    .select("id, campaign_id, session_id, scheduled_at, tentativas")
    .eq("campaign_id", campaignId)
    .eq("status", "agendado")
    .lte("scheduled_at", new Date().toISOString())
    .order("scheduled_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as unknown as QueueItem[];
}


// Cooldown persistente é reservado a RATE LIMIT explícito. Erro transitório
// (5xx/timeout/rede) pode reduzir o número no tick atual quando recorrente,
// mas não deve impor 5 minutos de lentidão depois que o provedor recuperou.
// Com migration 164 o cooldown de rate limit vale entre processos/restarts.
export async function persistCooldown(
  db: AdminDb,
  sessionId: string,
  reason: BackoffReason,
  cooldownSeconds: number
): Promise<void> {
  const until = Date.now() + cooldownSeconds * 1000;
  rememberCooldown(sessionId, until);
  try {
    const { error } = await db.from("dispatch_channel_cooldowns").upsert(
      {
        session_id: sessionId,
        cooldown_until: new Date(until).toISOString(),
        reason,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "session_id" }
    );
    if (error) console.warn("[Cron] Cooldown do canal só em memória:", error.message);
  } catch (error) {
    console.warn("[Cron] Cooldown do canal só em memória:", error);
  }
}


export interface SendStageInput {
  db: AdminDb;
  /** Campanhas já planejadas (janela, cadência, reflow e encerramento resolvidos por quem chama). */
  planned: PlannedCampaign[];
  config: ThroughputConfig;
  telemetry: TickTelemetry;
  /** true = as campanhas foram planejadas por fichas (claim em lote); nunca misturar os dois caminhos no mesmo estágio. */
  batchMode: boolean;
  /** Orçamento de tempo / lease perdido: nenhum trabalho novo começa quando devolve true. */
  outOfTime: () => boolean;
  health: ReturnType<typeof startHealthMonitor> | undefined;
  autoPauseConfig: ReturnType<typeof autoPauseConfigFromEnv>;
}

/** Envia o que foi planejado: números em paralelo, campanhas do mesmo número em round-robin, teto por número e global. */
export async function runSendStage(input: SendStageInput): Promise<SchedulerReport> {
  const { db, planned, config, telemetry, batchMode, outOfTime, health, autoPauseConfig } = input;
  const [channelWork, blacklistLookup] = await Promise.all([
    buildChannelWork(db, planned, config, telemetry),
    // Revalidação da blacklist de todos os candidatos do tick numa leitura
    // (tick-preload.ts); sem ela, cada envio consulta como antes.
    preloadBlacklist(
      db,
      planned.flatMap((entry) => entry.items.map(queueItemPrimaryPhone))
    ),
  ]);
  const plannedById = new Map(planned.map((entry) => [entry.campaign.id, entry]));
  const cooldownWrites: Array<Promise<void>> = [];
  const cooledDown = new Set<string>();
  const attemptsInTick = new Map<string, number>();
  const pauseChecks = new Map<string, Promise<boolean>>();
  const pausedCampaigns = new Set<string>();
  // Claim/confirmação em lote só quando TODAS as campanhas do tick foram planejadas por fichas (sem mistura de caminhos).
  const claimer = batchMode
    ? new ChannelClaimer({
        db,
        defaultMaxInFlight: (channelId) => channelWork.defaultMaxInFlight.get(channelId),
        preload: (claimed) => preloadBlacklist(db, claimed.map(queueItemPrimaryPhone)),
      })
    : null;
  const confirmBatcher = claimer ? new ConfirmBatcher({ db, single: singleConfirm(db) }) : null;
  // D-02: o SIGTERM espera os envios em voo ANTES de drenar o micro-lote de confirmações (registerShutdownDrain).
  const unregisterDrain = confirmBatcher ? registerShutdownDrain(confirmBatcher) : null;
  let schedule: SchedulerReport;
  try {
  schedule = await runDispatchSchedule<QueueItem>({
    channels: channelWork.channels,
    globalConcurrency: config.globalConcurrency,
    shouldStop: outOfTime,
    adaptiveBackoff: config.adaptiveBackoff,
    sampleHealth: () => health?.sample() ?? { eventLoopLagP99Ms: 0, rssMb: 0 },
    maxEventLoopLagMs: config.maxEventLoopLagMs,
    maxRssMb: config.maxRssMb,
    onBackoff: (event) => {
      console.warn("[Cron] Backoff adaptativo:", event);
      if (
        event.scope !== "channel" ||
        !event.channelId ||
        event.reason !== "rate_limit" ||
        config.cooldownSeconds <= 0
      ) return;
      if (cooledDown.has(event.channelId)) return;
      cooledDown.add(event.channelId);
      cooldownWrites.push(persistCooldown(db, event.channelId, event.reason, config.cooldownSeconds));
    },
    run: async (token, ctx) => {
      const entry = plannedById.get(ctx.campaignId);
      if (!entry) return;
      // Ficha sem claimer (nunca deveria acontecer: o modo é decidido antes de planejar): não envia nada.
      if (!claimer && isClaimToken(token)) return;
      let item = token;
      let itemBlacklist = blacklistLookup;
      if (claimer) {
        // A ficha só ocupa a vaga: o item real sai do claim em lote (já 'enviando'). Sem item = nada vencido/cota/limite → ficha vira no-op.
        let claimed: Awaited<ReturnType<ChannelClaimer["next"]>> = null;
        try {
          claimed = await claimer.next(ctx.channelId, ctx.campaignId, ctx.slotsFree);
        } catch (error) {
          telemetry.recordOutcome(ctx.channelId, "exception");
          console.error("[Cron] Falha no claim em lote:", ctx.channelId, error);
          return;
        }
        if (!claimed) return;
        item = claimed.item;
        itemBlacklist = claimed.blacklistLookup ?? blacklistLookup;
      }
      let signal = null as BackoffReason | null;
      let pauseCampaign = false;
      try {
        // D-02: registra o envio em voo (claim → confirmação); no SIGTERM o processo espera até 8 s por estes antes de sair.
        const outcome = await trackSend(processQueueItem(item, entry.campaign, {
          defaultMaxInFlight: channelWork.defaultMaxInFlight.get(ctx.channelId),
          channelConfig: channelConfigFor(channelWork.configs, ctx.channelId, entry.campaign.account_id),
          blacklistLookup: itemBlacklist,
          alreadyClaimed: !!claimer,
          confirmBatcher: confirmBatcher ?? undefined,
          onProviderCall: (observation) => {
            telemetry.recordProviderCall(observation.provider, observation.latencyMs, observation.code);
            signal = observation.signal ?? signal;
          },
        }));
        telemetry.recordOutcome(ctx.channelId, outcome.outcome);
        if (outcome.outcome === "sent") entry.result.sent++;
        if (outcome.outcome === "pending_confirmation") entry.result.pending_confirmation++;
        // Reavalia também dentro de lotes grandes (por número), sem uma
        // query por envio. Uma checagem compartilhada por campanha; outros
        // números/campanhas continuam livres no agendador.
        if (autoPauseConfig.enabled && (outcome.outcome === "sent" || outcome.outcome === "error")) {
          const attempts = (attemptsInTick.get(ctx.campaignId) ?? 0) + 1;
          attemptsInTick.set(ctx.campaignId, attempts);
          let checking = pauseChecks.get(ctx.campaignId);
          if (!checking && attempts % autoPauseConfig.minAttempts === 0 && !outOfTime()) {
            checking = checkCampaignAutoPause(db, entry.campaign, autoPauseConfig);
            pauseChecks.set(ctx.campaignId, checking);
          }
          if (checking) {
            if (await checking) pausedCampaigns.add(ctx.campaignId);
            if (pauseChecks.get(ctx.campaignId) === checking) pauseChecks.delete(ctx.campaignId);
          }
          pauseCampaign = pausedCampaigns.has(ctx.campaignId);
        }
      } catch (error) {
        // Exceção depois da chamada ao provedor NÃO devolve o item à fila:
        // ele fica 'enviando' para reconciliação, evitando reenvio cego.
        telemetry.recordOutcome(ctx.channelId, "exception");
        console.error("[Cron] Item requer investigação:", item.id, error);
      }
      return { backoff: signal, pauseCampaign };
    },
  });
  } finally {
    // Fim do tick: devolve a 'agendado' o que foi reivindicado e não chegou ao envio, e grava o micro-lote de confirmações pendente.
    await claimer?.releaseLeftovers();
    await confirmBatcher?.drain();
    unregisterDrain?.();
  }
  await Promise.allSettled(cooldownWrites);
  // Fecha a avaliação dos lotes menores que o intervalo de checagem.
  for (const entry of planned) {
    if (outOfTime()) break;
    if (!pausedCampaigns.has(entry.campaign.id))
      await checkCampaignAutoPause(db, entry.campaign, autoPauseConfig);
  }
  return schedule;
}
