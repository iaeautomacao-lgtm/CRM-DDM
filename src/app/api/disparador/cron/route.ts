import { after, NextResponse } from "next/server";
import { registerAuditActor } from '@/lib/audit/context'
import { randomUUID } from 'node:crypto';
import { drainCallbackOutbox } from '@/lib/disparador/callback-outbox';
import { matchesOperationalSecret } from "@/lib/auth/operational-secret";
import {
  processQueueItem,
  type QueueItem,
  type Campaign,
} from "@/lib/disparador/processQueue";
import { canSendNow } from "@/lib/disparador/send-window";
import { resolveDispatchProcessConcurrency } from "@/lib/disparador/concurrency";
import { runDispatchSchedule, type ChannelWork, type SchedulerReport } from "@/lib/disparador/dispatch-scheduler";
import { TickTelemetry, startHealthMonitor } from "@/lib/disparador/dispatch-telemetry";
import type { BackoffReason } from "@/lib/disparador/provider-signals";
import {
  isInCooldown,
  MAX_PER_NUMBER_CONCURRENCY,
  rememberCooldown,
  resolveChannelConcurrency,
  resolveThroughputConfig,
  type DispatchProvider,
  type ThroughputConfig,
} from "@/lib/disparador/throughput-config";
import { writeLog } from "@/lib/logger";
import {
  resolveCronBatchCandidateLimit,
  resolveCronCandidateCap,
  shouldReserveCampaignCadence,
} from "@/lib/disparador/cron-batching";
import { isPrepareInTickEnabled, prepareDueCampaigns, recoverStuckPreparing } from "@/lib/disparador/prepare-campaigns";
import { channelConfigFor, preloadBlacklist, queueItemPrimaryPhone } from "@/lib/disparador/tick-preload";
import { needsQueueReflow, reflowCampaignQueue } from "@/lib/disparador/queue-reflow";
import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { autoPauseConfigFromEnv, checkCampaignAutoPause } from "@/lib/disparador/auto-pause";
import { ChannelClaimer, isBatchClaimEnabled, isClaimToken, planClaimTokens } from "@/lib/disparador/batch-claim";
import { ConfirmBatcher, registerShutdownDrain, singleConfirm } from "@/lib/disparador/confirm-batcher";
import {
  fireNextHop,
  isMaintenanceHop,
  readChainContext,
  resolveTickChainConfig,
  shouldChainNext,
  type ChainContext,
} from "@/lib/disparador/tick-chain";
import { drainDispatchMoves } from "@/lib/disparador/queue-moves";
import { derivedSlots, effectiveRate, policyFromRow, type RateState } from "@/lib/disparador/channel-rate";
import { cleanupOrphanReceipts } from "@/lib/disparador/receipts-cleanup";
import { drainPushOutbox } from "@/lib/push/service";
import { trackSend } from "@/lib/disparador/shutdown-gate";
import { sweepStuckApiCampaigns } from "@/lib/disparador/api-v1-cleanup";
import { recoverStaleSendingReservations } from "@/lib/disparador/reconcile-unknown-provider-outcomes";
import { drainStatusInbox } from "@/lib/whatsapp/status-inbox";
import { drainMessageInboxLive } from "@/lib/whatsapp/message-inbox-runner";
import { reconcileShadowInbox } from "@/lib/whatsapp/message-inbox";

// ============================================================
// /api/disparador/cron — motor stateless do disparador.
//
// GET  → só diagnóstico (health check). Não tem efeitos colaterais.
// POST → executa um tick: prepara campanhas agendadas, consome a fila e
//        entrega callbacks. Os agendadores externos devem usar POST.
//
// Ambos exigem o header `x-cron-secret` == CRON_SECRET. Sem a variável
// configurada a rota responde 503 (fail-closed), nunca libera o acesso.
//
// Toda a coordenação de concorrência fica no banco (migrations 118–125):
// lock do cron com lease, reserva de cadência por campanha, claim por item
// com quota/concorrência por canal. Assim, ticks sobrepostos ou várias
// instâncias do Passenger não geram envio duplicado.
// ============================================================

type AdminDb = ReturnType<typeof supabaseAdmin>;

interface PlannedCampaign {
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

async function buildChannelWork(
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
    const rateRow = provider === "waha" ? undefined : rateRows.get(channelId);
    if (rateRow) {
      const accountId = configs?.get(channelId)?.account_id as string | undefined;
      const policy = policyFromRow(accountId ? policyByAccount.get(accountId) : null);
      const effective = effectiveRate(rateRow as RateState, policy, now, { inCooldown });
      ratePerSecond = effective.rate;
      maxConcurrency = derivedSlots(effective.rate, assumedP95Seconds(), channelInfo?.maxInFlight ?? MAX_PER_NUMBER_CONCURRENCY);
    }
    // Sem linha no banco, o claim usa o padrão do provedor como teto
    // atômico (claim_dispatch_item_capped); com linha, vale a linha.
    defaultMaxInFlight.set(
      channelId,
      channelInfo?.maxInFlight ? undefined : ratePerSecond !== undefined ? maxConcurrency : config.perNumber[provider ?? "unknown"]
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

const CANDIDATE_PAGE_SIZE = 1000;

// O retry de erros transitórios roda no máximo a cada ~5 ticks: o lock
// expira sozinho (não é liberado) e só o tick que o adquire chama a RPC.
const RETRY_LOCK_TTL_SECONDS = 270;
// Confirmação das ocorrências 131026 pendentes (a cada ~5 ticks, lock próprio).
const META_131026_CONFIRM_LOCK_TTL_SECONDS = 270;
// Consolidação dos deltas de métricas (migration 183): lock próprio, só com sobra de tempo.
const METRICS_CONSOLIDATE_LOCK_TTL_SECONDS = 30;
const METRICS_CONSOLIDATE_BATCH = 20_000;
// Lock do tick: curto; renovado a cada 20 s pelo heartbeat (renew_cron_lock, TTL padrão 90 s após a migration 184).
const CRON_LOCK_TTL_SECONDS = 90;
// Movimentação de itens de campanhas pausadas/encerradas/retomadas (migration 184): tempo máximo por tick.
const QUEUE_MOVES_BUDGET_MS = 8_000;
const METRICS_CONSOLIDATE_MAX_ROUNDS = 5;

/** Janela (min) sem delivered/read para um failed 131026 (aparelho offline também gera) virar erro definitivo. */
function meta131026ConfirmMinutes(): number {
  const parsed = Number(process.env.DISPARADOR_131026_CONFIRM_MINUTES);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 1440;
}

// Candidatos vencidos de uma campanha, na ordem (scheduled_at, id), em
// páginas de 1.000 (o PostgREST corta cada resposta no max-rows, 1.000 por
// padrão no Supabase). Nada é reservado aqui: o claim decide.
async function fetchDueCandidates(db: AdminDb, campaignId: string, limit: number): Promise<QueueItem[]> {
  const items: QueueItem[] = [];
  const now = new Date().toISOString();
  while (items.length < limit) {
    const from = items.length;
    const to = Math.min(limit, from + CANDIDATE_PAGE_SIZE) - 1;
    const { data, error } = await db
      .from("disp_message_queue")
      .select("*, contacts(name, phone, company)")
      .eq("campaign_id", campaignId)
      .eq("status", "agendado")
      .lte("scheduled_at", now)
      // Desempate por id: a rodada inteira vence em < 2 s
      // (roundSpreadOffsetMs), então muitos itens dividem o scheduled_at.
      .order("scheduled_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw error;
    const page = (data ?? []) as QueueItem[];
    items.push(...page);
    if (page.length < to - from + 1) break;
  }
  return items;
}

// Amostra dos itens vencidos mais antigos (sem OFFSET, sem contatos): só para o detector de reflow no caminho em lote (188).
async function fetchDueSample(db: AdminDb, campaignId: string, limit = 200): Promise<QueueItem[]> {
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
async function persistCooldown(
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

function authorize(request: Request): NextResponse | null {
  if (!process.env.CRON_SECRET)
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!matchesOperationalSecret(process.env.CRON_SECRET, request.headers.get("x-cron-secret"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

// Diagnóstico apenas: não inicia campanhas, não consome fila, não faz
// retry nem emite callbacks. Antes o GET executava o tick inteiro, e cada
// health check (monitor, stress test) virava um disparo real.
export async function GET(request: Request) {
  const rejection = authorize(request);
  if (rejection) return rejection;
  const { error } = await supabaseAdmin().from("campaigns").select("id").limit(1);
  return NextResponse.json(
    {
      status: error ? "unavailable" : "healthy",
      process_concurrency: resolveDispatchProcessConcurrency(),
    },
    { status: error ? 503 : 200 }
  );
}

// Um tick. `chain` diz em que hop da cadeia estamos (hop 0 = cron externo): a manutenção pesada só roda a cada N hops.
async function runTick(request: Request, chain: ChainContext) {
  const maintenanceHop = isMaintenanceHop(chain.hop, resolveTickChainConfig().maintenanceEvery);
  // Auditoria: escritas desta requisição saem como "system" (cron_disparador).
  await registerAuditActor({ actorType: 'system', source: 'cron_disparador' })
  const rejection = authorize(request);
  if (rejection) return rejection;
  // Identifica esta execução como dona do lock (renovação/liberação só
  // funcionam para o mesmo owner).
  const owner = randomUUID();
  let locked = false;
  // Vira true se a renovação do lock falhar: outro tick pode ter assumido,
  // então paramos de iniciar trabalho novo o quanto antes.
  let lostLease = false;
  let renewFailures = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  // Botões de vazão (throughput-config.ts). Padrões = comportamento antigo.
  const config = resolveThroughputConfig();
  const autoPauseConfig = autoPauseConfigFromEnv();
  const tickStartedAt = Date.now();
  // Orçamento de tempo do tick: nenhum trabalho novo começa depois dele
  // (padrão 35s = o antigo deadline de 40s menos 5s de folga), para a
  // requisição terminar antes do timeout do agendador/proxy.
  const stopAt = tickStartedAt + config.tickBudgetMs;
  const outOfTime = () => lostLease || Date.now() > stopAt;
  // Telemetria do tick (uma linha cron_tick em system_logs, no finally).
  const telemetry = new TickTelemetry();
  let health: ReturnType<typeof startHealthMonitor> | undefined;
  let schedule: SchedulerReport | null = null;
  let plannedCount = 0;
  let tickStatus = "error";
  try {
    const db = supabaseAdmin();
    // Só um tick por vez em todo o cluster. TTL curto (90 s, migration 184): o heartbeat de 20 s renova
    // durante o tick; se o processo morrer (deploy/crash) o lock expira em ~1,5 min e o próximo tick entra.
    const { data: acquired, error: lockError } = await db.rpc('try_acquire_cron_lock', {
      p_name: 'disparador_cron', p_owner_id: owner, p_ttl_seconds: CRON_LOCK_TTL_SECONDS,
    });
    if (lockError) throw lockError;
    if (!acquired) return NextResponse.json({ status: 'already_running' });
    locked = true;
    health = startHealthMonitor();
    // Heartbeat do lease. Este setInterval vive só durante a requisição
    // (é limpo no finally) — não é worker em memória, então é compatível
    // com o Passenger.
    heartbeat = setInterval(() => {
      void (async () => {
        try {
          const { data, error } = await db.rpc('renew_cron_lock', { p_name: 'disparador_cron', p_owner: owner });
          // data === false: outro dono assumiu o lease → perdeu na hora. Erro/timeout transitório (Supabase lento sob carga)
          // só derruba o tick na 3ª falha seguida (~60 s, abaixo do TTL de 90 s); antes, 1 falha parava o tick inteiro (F17).
          if (!error && data === false) lostLease = true;
          else if (error || !data) { if (++renewFailures >= 3) lostLease = true; }
          else renewFailures = 0;
        } catch { if (++renewFailures >= 3) lostLease = true; }
      })();
    }, 20_000);
    if (maintenanceHop) {
    // Reaplica recibos de status (delivered/read/failed) que chegaram antes
    // da confirmação local do envio e entrega um callback pendente. Vem
    // primeiro para não ficar sempre sem tempo quando a fila está cheia.
    const { error: receiptsError } = await db.rpc('reconcile_dispatch_receipts', { p_limit: 500 });
    if (receiptsError) throw receiptsError;
    // Rede de segurança do webhook de status em lote (migration 185): aplica o que o after() do webhook
    // não conseguiu (processo caiu entre o 200 e o apply, ele não ganhou a vez…). Só com sobra de tempo e
    // limitado (no máx. ~8 s do orçamento), para nunca atrasar os envios; sem a migration, é no-op.
    const drainDeadline = tickStartedAt + Math.min(8_000, Math.floor(config.tickBudgetMs / 4));
    await drainStatusInbox(db, {
      limit: 1000,
      maxBatches: 5,
      shouldStop: () => outOfTime() || Date.now() > drainDeadline,
    });
    // Rede de segurança do inbox de MENSAGENS da Meta (migration 201): processa o que o after() do webhook não
    // concluiu (processo caiu entre o 200 e o processamento, lease expirado, retry com backoff) e, no modo shadow,
    // só compara com `messages`. Só com sobra de tempo, lock próprio e espera limitada (~6 s) para nunca atrasar os
    // envios; trabalho que passar do limite segue no processo com a reserva (lease) e fecha sozinho. Sem a migration, no-op.
    if (!outOfTime()) {
      try {
        const { data: inboxTurn } = await db.rpc("try_acquire_cron_lock", {
          p_name: "webhook_message_inbox_cron", p_owner_id: owner, p_ttl_seconds: 60,
        });
        if (inboxTurn) {
          try {
            const inboxDeadline = Date.now() + Math.min(6_000, Math.floor(config.tickBudgetMs / 6));
            const work = Promise.all([
              drainMessageInboxLive(db, { limit: 20, maxBatches: 2, shouldStop: () => outOfTime() || Date.now() > inboxDeadline }),
              reconcileShadowInbox(db),
            ]);
            await Promise.race([work, new Promise((resolve) => setTimeout(resolve, Math.max(inboxDeadline - Date.now(), 0)))]);
          } finally {
            await db.rpc("release_cron_lock", { p_name: "webhook_message_inbox_cron", p_owner_id: owner });
          }
        }
      } catch (error) {
        console.error("[Cron] Falha na rede de segurança do inbox de mensagens:", error instanceof Error ? error.message : error);
      }
    }
    await drainCallbackOutbox(1);
    // Watchdog anti-deadlock. É manutenção best-effort: falha aqui nunca
    // derruba o tick nem impede novos envios.
    try {
      const recovered = await recoverStaleSendingReservations(db);
      if (recovered.recoveredAccepted > 0 || recovered.finalizedUnknown > 0 || recovered.requeuedNeverSent > 0 || recovered.failed > 0) {
        for (const campaignId of recovered.campaignIds) {
          const { error: completeError } = await db.rpc("complete_dispatch_campaign", {
            p_campaign_id: campaignId,
          });
          if (completeError)
            console.error("[Cron] Watchdog: falha ao tentar finalizar campanha:", campaignId, completeError.message);
        }
        await writeLog({
          level: recovered.failed > 0 ? "warn" : "info",
          source: "disparador",
          event: "dispatch_stale_sending_recovered",
          message: "Watchdog liberou reservas antigas: devolveu à fila o que nunca chegou ao provedor e fechou como incerto o que pode ter saído (nunca reenvia este)",
          payload: recovered,
        });
      }
    } catch (watchdogError) {
      console.error("[Cron] Watchdog falhou; envio continua:", watchdogError);
    }
    } // fim da manutenção (hop 0 e a cada N hops encadeados)
    // Preflight de deploy: se a coluna next_batch_at (migration 118) não
    // existir, o código novo subiu sem as migrations. Para aqui, antes de
    // qualquer preparação de campanha ou envio externo.
    const { error: readinessError } = await db.from("campaigns").select("next_batch_at").limit(1);
    if (readinessError) {
      tickStatus = "migration_required";
      return NextResponse.json({ error: "Dispatch safety migration required" }, { status: 503 });
    }
    // 0/1) Preparação de campanhas agendadas. B9: o caminho normal é a rota
    //    própria /api/disparador/prepare/cron (lock disparador_prepare), para
    //    uma campanha de 100k (2–6 min) não parar o envio de todas as outras.
    //    Fallback: enquanto DISPARADOR_PREPARE_IN_TICK não for "false" (padrão
    //    true, até o agendador chamar a rota nova), o tick ainda prepara —
    //    antes de tudo, recuperando o que ficou preso em 'preparando' (30 min
    //    sem updated_at: volta a 'agendado' se tiver agendamento, senão a
    //    'rascunho') e preparando as vencidas, uma por vez, dentro do orçamento.
    if (maintenanceHop && isPrepareInTickEnabled()) {
      await recoverStuckPreparing(db);
      await prepareDueCampaigns(db, { outOfTime });
    }
    // 2) Devolve para 'agendado' apenas erros transitórios já classificados
    //    (nunca itens 'enviando' — esses podem ter sido aceitos pelo provedor).
    //    A cada ~5 ticks (lock com TTL, sem release): o item só volta 5+ min
    //    depois do erro e com backoff de minutos, então rodar todo tick só
    //    custava banco. Falha aqui não derruba o tick (antes: 503 em todo
    //    tick se a função estourasse o statement_timeout).
    const { data: retryTurn, error: retryLockError } = await db.rpc("try_acquire_cron_lock", {
      p_name: "disparador_retry",
      p_owner_id: owner,
      p_ttl_seconds: RETRY_LOCK_TTL_SECONDS,
    });
    if (retryLockError) console.error("[Cron] Falha no lock do retry de erros transitórios:", retryLockError.message);
    if (retryTurn) {
      const { error: retryError } = await db.rpc("retry_transient_queue_errors");
      if (retryError) console.error("[Cron] Falha no retry de erros transitórios:", retryError.message);
    }
    // 2b) 131026 é provisório: confirma as ocorrências pendentes mais velhas
    //     que a janela (sem delivered/read) e aplica a regra das 3 campanhas.
    //     Só se sobrar tempo no tick; lock próprio, como o do retry.
    if (!outOfTime()) {
      const { data: confirmTurn, error: confirmLockError } = await db.rpc("try_acquire_cron_lock", {
        p_name: "disparador_131026_confirm",
        p_owner_id: owner,
        p_ttl_seconds: META_131026_CONFIRM_LOCK_TTL_SECONDS,
      });
      if (confirmLockError) console.error("[Cron] Falha no lock da confirmação 131026:", confirmLockError.message);
      if (confirmTurn) {
        const { error: confirmError } = await db.rpc("confirm_pending_meta_131026", {
          p_window_minutes: meta131026ConfirmMinutes(),
          p_limit: 200,
        });
        if (confirmError) console.error("[Cron] Falha ao confirmar 131026 pendentes:", confirmError.message);
      }
    }
    // 2c) Métricas: soma os deltas pendentes de campaign_metrics (increment_campaign_metric só insere
    //     deltas — sem linha quente) e apaga os consolidados, em lotes. Só se sobrar tempo; lock próprio.
    //     Atrasar não perde nada: a leitura (campaign_metrics_live) já soma os deltas pendentes.
    if (!outOfTime()) {
      const { data: metricsTurn, error: metricsLockError } = await db.rpc("try_acquire_cron_lock", {
        p_name: "disparador_metrics",
        p_owner_id: owner,
        p_ttl_seconds: METRICS_CONSOLIDATE_LOCK_TTL_SECONDS,
      });
      if (metricsLockError) console.error("[Cron] Falha no lock da consolidação de métricas:", metricsLockError.message);
      if (metricsTurn) {
        for (let round = 0; round < METRICS_CONSOLIDATE_MAX_ROUNDS && !outOfTime(); round++) {
          const { data: consolidated, error: consolidateError } = await db.rpc("consolidate_campaign_metrics", {
            p_limit: METRICS_CONSOLIDATE_BATCH,
          });
          if (consolidateError) {
            console.error("[Cron] Falha ao consolidar métricas:", consolidateError.message);
            break;
          }
          if ((Number(consolidated) || 0) < METRICS_CONSOLIDATE_BATCH) break;
        }
        const { error: releaseError } = await db.rpc("release_cron_lock", { p_name: "disparador_metrics", p_owner_id: owner });
        if (releaseError) console.error("[Cron] Falha ao liberar o lock de métricas:", releaseError.message);
      }
    }
    // 2d) Itens de campanhas pausadas/encerradas/retomadas: a RPC de stop/resume só trocou o status; os itens
    //     movem em lotes aqui (e pela rota). Só com sobra de tempo; falha/RPC ausente não derruba o tick.
    if (!outOfTime()) {
      const moved = await drainDispatchMoves(db, null, { budgetMs: QUEUE_MOVES_BUDGET_MS });
      if (moved.moved > 0) console.log("[Cron] Itens movidos após pausa/encerramento/retomada:", moved.moved, moved.partial ? "(parcial)" : "");
    }
    // 3) Campanhas em execução, mais "atrasadas" primeiro (fairness entre
    //    campanhas quando o tick não dá conta de todas).
    const { data: active, error: activeError } = await db
      .from("campaigns")
      .select(
        "id, account_id, status, janela_inicio, janela_fim, dias_envio, batch_size, batch_pause_seconds, limite_por_hora"
      )
      .eq("status", "em_execucao").order('next_batch_at', { ascending: true, nullsFirst: true });
    if (activeError) throw activeError;
    // 3a) Planejamento: para cada campanha, as mesmas checagens de antes
    //     (janela/dias, cadência do sequencial, fila vazia → encerrar,
    //     reflow do lote). Nada é enviado aqui; os candidatos de todas as
    //     campanhas vão para o agendador por número (3b).
    const planned: PlannedCampaign[] = [];
    const candidateCap = resolveCronCandidateCap(config);
    // Claim em lote (migration 188, DISPARADOR_BATCH_CLAIM=0 desliga): fichas por campanha×número no planejamento e itens reivindicados
    // em lotes por número. Se as RPCs não existirem, volta sozinho ao caminho por item (fetchDueCandidates + claim unitário).
    let batchMode = isBatchClaimEnabled();
    for (const campaign of (active ?? []) as Campaign[]) {
      if (outOfTime()) break;
      // Avalia antes de planejar para não enviar outra rodada de uma
      // campanha que já passou do limite no tick anterior.
      if (await checkCampaignAutoPause(db, campaign, autoPauseConfig)) continue;
      if (outOfTime()) break;
      if (
        !canSendNow({ inicio: campaign.janela_inicio, fim: campaign.janela_fim, dias: campaign.dias_envio })
      )
        continue;
      // Sequential campaigns (batch_size=1) still use the database cadence
      // reservation. Batched/segmented campaigns already encode their logical
      // pause in disp_message_queue.scheduled_at when startCampaign builds the
      // queue. Reserving batch_pause_seconds again here used to double-apply
      // the pause: a 614-item logical batch sent only the first 100 candidates
      // and then waited one full hour before continuing.
      if (shouldReserveCampaignCadence(campaign.batch_size)) {
        const { data: reserved, error: reservationError } = await db.rpc("reserve_campaign_tick", {
          p_campaign_id: campaign.id,
        });
        if (reservationError) throw reservationError;
        if (!reserved) continue;
      }

      // This is a candidate-fetch limit, not provider concurrency (that is
      // the per-number/global caps of the scheduler below), but allow a
      // logical segmented batch such as 614 contacts to be selected. The tick
      // budget may leave
      // part of the batch for the next cron invocation; because batched
      // campaigns no longer reserve an extra pause, the next tick resumes the
      // remaining due rows immediately. The cap is derived from the tick's
      // max throughput (cron-batching.ts), never below the old fixed 700.
      const batchSize = resolveCronBatchCandidateLimit(campaign.batch_size, candidateCap);
      let items: QueueItem[];
      let claimTokens: QueueItem[] | null = null;
      if (batchMode) {
        const plan = await planClaimTokens(db, campaign.id, batchSize);
        if (plan === null) {
          batchMode = false;
          console.warn("[Cron] count_due_dispatch_items indisponível (migration 188 não aplicada); usando o claim por item.");
          items = await fetchDueCandidates(db, campaign.id, batchSize);
        } else {
          claimTokens = plan.tokens;
          items = plan.tokens.length ? await fetchDueSample(db, campaign.id) : [];
        }
      } else {
        items = await fetchDueCandidates(db, campaign.id, batchSize);
      }
      if (!items.length) {
        // Fila vazia: tenta encerrar a campanha. A RPC usa o mesmo lock de
        // campanha dos claims e só encerra se não houver item agendado,
        // enviando (incl. resultado desconhecido), pausado ou com retry
        // pendente. Ao encerrar, já enfileira o callback na outbox.
        const { data: completed, error: completionError } = await db.rpc(
          "complete_dispatch_campaign",
          { p_campaign_id: campaign.id }
        );
        if (completionError) throw completionError;
        if (completed) {
          const { error: recalcError } = await db.rpc("recalculate_campaign_metrics", {
            p_campaign_id: campaign.id,
          });
          if (recalcError)
            console.error("[Cron] Falha ao recalcular métricas:", recalcError.message);
        }
        continue;
      }
      // Lote/"Segmentado": fila com rodadas agendadas em período fechado
      // (montada antes do relógio de janela, retomada…) é redistribuída uma
      // vez, mantendo ordem e ritmo em tempo aberto (queue-reflow.ts). Este
      // tick não envia nada da campanha: o próximo já pega a 1ª rodada nova.
      // Se o reflow falhar, também não envia — melhor esperar um tick do
      // que soltar a rajada.
      if (
        needsQueueReflow(
          items,
          { inicio: campaign.janela_inicio, fim: campaign.janela_fim, dias: campaign.dias_envio },
          campaign.batch_size ?? 1
        )
      ) {
        const reflow = await reflowCampaignQueue(campaign);
        if (reflow.ok)
          console.log("[Cron] Fila redistribuída na janela:", campaign.id, reflow.items, "itens via", reflow.via);
        else console.error("[Cron] Falha ao redistribuir a fila na janela:", campaign.id, reflow.error);
        continue;
      }
      planned.push({
        campaign,
        items: claimTokens ?? items,
        result: { campaign_id: campaign.id, sent: 0, pending_confirmation: 0 },
      });
    }
    plannedCount = planned.length;

    // 3b) Envio, agendado por NÚMERO (dispatch-scheduler.ts): números em
    //     paralelo, campanhas do mesmo número em round-robin, teto por número
    //     e teto global. O SELECT acima não reserva nada: cada item ainda
    //     passa pelo claim atômico dentro de processQueueItem
    //     (claim_dispatch_item), que pode recusá-lo.
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
    const results = planned.map((entry) => entry.result);
    // Sobrou tempo? Entrega mais callbacks (inclusive de campanhas
    // encerradas neste tick).
    if (maintenanceHop && !lostLease && Date.now() < stopAt - 5_000) await drainCallbackOutbox();
    if (maintenanceHop) await cleanupOrphanReceipts(db, stopAt, () => lostLease);
    // Rede de segurança do push "Nova conversa em espera" (migration 298): entrega o que o after() do webhook não entregou
    // (ex.: conversa do Webchat). Nunca lança; sem a migration é no-op.
    if (maintenanceHop && !lostLease && Date.now() < stopAt - 10_000) await drainPushOutbox(db, { limit: 50 });
    // A7: libera criações da API v1 interrompidas (rascunho sem ativar > 15 min). Best-effort, só com sobra de tempo.
    if (maintenanceHop && !lostLease && Date.now() < stopAt - 10_000) {
      try { await sweepStuckApiCampaigns(db); } catch (error) { console.error("[Cron] Falha ao varrer rascunhos da API v1:", error); }
    }
    tickStatus = results.length ? "processed" : "idle";
    return NextResponse.json({
      status: tickStatus,
      process_concurrency: config.globalConcurrency,
      results,
    });
  } catch (error) {
    tickStatus = "error";
    console.error("[Cron] Falha operacional:", error);
    return NextResponse.json({ error: "Dispatch processing unavailable" }, { status: 503 });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (locked) {
      // Uma linha por tick para calibrar os botões (ver dispatch-telemetry.ts).
      const summary = health?.summary() ?? { eventLoopLagP99Ms: 0, rssMb: 0, rssPeakMb: 0 };
      health?.stop();
      const payload = telemetry.buildPayload({
        durationMs: Date.now() - tickStartedAt,
        status: tickStatus,
        config,
        campaigns: plannedCount,
        schedule,
        health: summary,
      });
      await writeLog({
        level: schedule?.backoffEvents.length ? "warn" : "info",
        source: "disparador",
        event: "cron_tick",
        message: `Tick do disparador (${tickStatus})`,
        payload,
      });
    }
    // Libera o lock explicitamente para o próximo tick não esperar o TTL.
    // Falha aqui só é logada: o TTL garante a liberação de qualquer forma.
    if (locked) {
      try {
        const { error } = await supabaseAdmin().rpc('release_cron_lock', { p_name: 'disparador_cron', p_owner_id: owner });
        if (error) console.error('[Cron] Falha ao liberar lock:', error.message);
      } catch (error) { console.error('[Cron] Falha ao liberar lock:', error); }
    }
  }
}

// Tick encadeado (tick-chain.ts): ao terminar um tick que PROCESSOU trabalho (lock já liberado no finally de runTick), dispara o
// próximo hop via after() — sem esperar. O hop encadeado (header x-cron-hop) responde 202 na hora e roda o tick em after(), então
// nenhuma requisição fica presa ao proxy; o cron externo (hop 0) continua síncrono e é o ressuscitador da cadeia.
export async function POST(request: Request) {
  const chainConfig = resolveTickChainConfig();
  const ctx = readChainContext(request.headers);
  const secret = process.env.CRON_SECRET ?? "";

  const chainAfter = (response: NextResponse, status: string) => {
    const decision = shouldChainNext({ config: chainConfig, ctx, tickStatus: status });
    if (decision.chain) {
      after(async () => {
        await fireNextHop({ config: chainConfig, ctx, secret });
      });
    }
    return response;
  };

  if (chainConfig.enabled && ctx.chained) {
    const rejection = authorize(request);
    if (rejection) return rejection;
    after(async () => {
      const response = await runTick(request, ctx);
      const status = await response.clone().json().then((body) => String(body?.status ?? ""), () => "");
      const decision = shouldChainNext({ config: chainConfig, ctx, tickStatus: status });
      if (decision.chain) await fireNextHop({ config: chainConfig, ctx, secret });
    });
    return NextResponse.json({ status: "chained", hop: ctx.hop }, { status: 202 });
  }

  const response = await runTick(request, ctx);
  if (!chainConfig.enabled) return response;
  const status = await response.clone().json().then((body) => String(body?.status ?? ""), () => "");
  return chainAfter(response, status);
}
