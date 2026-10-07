import { NextResponse } from "next/server";
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
import { cleanupOrphanReceipts } from "@/lib/disparador/receipts-cleanup";

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
  const info = new Map<string, { provider: DispatchProvider | null; maxInFlight: number | null; cooldownUntil: string | null }>();
  let configs: Map<string, Record<string, any>> | null = new Map();
  if (ids.length) {
    const [providers, limits, cooldowns] = await Promise.all([
      // Linha inteira: o envio usa esta leitura (uma por tick) em vez de
      // ler o canal a cada item.
      db.from("whatsapp_config").select("*").in("id", ids),
      db.from("dispatch_channel_limits").select("*").in("session_id", ids),
      // Tabela da migration 164; sem ela, só vale o cooldown em memória.
      db.from("dispatch_channel_cooldowns").select("session_id, cooldown_until").in("session_id", ids),
    ]);
    if (providers.error) {
      console.error("[Cron] Falha ao ler provedores dos canais:", providers.error.message);
      configs = null;
    }
    if (limits.error) console.error("[Cron] Falha ao ler limites dos canais:", limits.error.message);
    for (const id of ids) info.set(id, { provider: null, maxInFlight: null, cooldownUntil: null });
    for (const row of (providers.data ?? []) as Array<Record<string, any> & { id: string; provider: string | null }>) {
      configs?.set(row.id, row);
      const entry = info.get(row.id);
      if (entry && (row.provider === "meta" || row.provider === "waha")) entry.provider = row.provider;
    }
    for (const row of (limits.data ?? []) as Array<{ session_id: string; max_in_flight: number | null }>) {
      const entry = info.get(row.session_id);
      if (entry) entry.maxInFlight = row.max_in_flight ?? null;
    }
    for (const row of (cooldowns.data ?? []) as Array<{ session_id: string; cooldown_until: string | null }>) {
      const entry = info.get(row.session_id);
      if (entry) entry.cooldownUntil = row.cooldown_until;
    }
  }
  const now = Date.now();
  const channels: ChannelWork<QueueItem>[] = [];
  const defaultMaxInFlight = new Map<string, number | undefined>();
  for (const [channelId, campaigns] of byChannel) {
    const channelInfo = info.get(channelId);
    const provider = channelInfo?.provider ?? null;
    const inCooldown = isInCooldown(channelId, now, channelInfo?.cooldownUntil);
    const maxConcurrency = resolveChannelConcurrency({
      provider,
      rowMaxInFlight: channelInfo?.maxInFlight,
      inCooldown,
      config,
    });
    // Sem linha no banco, o claim usa o padrão do provedor como teto
    // atômico (claim_dispatch_item_capped); com linha, vale a linha.
    defaultMaxInFlight.set(
      channelId,
      channelInfo?.maxInFlight ? undefined : config.perNumber[provider ?? "unknown"]
    );
    telemetry.channel(channelId, provider, inCooldown);
    channels.push({
      channelId,
      maxConcurrency,
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

export async function POST(request: Request) {
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
    // Só um tick por vez em todo o cluster. TTL de 600s cobre crash do
    // processo: o lock expira sozinho e o próximo tick consegue entrar.
    const { data: acquired, error: lockError } = await db.rpc('try_acquire_cron_lock', {
      p_name: 'disparador_cron', p_owner_id: owner, p_ttl_seconds: 600,
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
          if (error || !data) lostLease = true;
        } catch { lostLease = true; }
      })();
    }, 20_000);
    // Reaplica recibos de status (delivered/read/failed) que chegaram antes
    // da confirmação local do envio e entrega um callback pendente. Vem
    // primeiro para não ficar sempre sem tempo quando a fila está cheia.
    const { error: receiptsError } = await db.rpc('reconcile_dispatch_receipts', { p_limit: 100 });
    if (receiptsError) throw receiptsError;
    await drainCallbackOutbox(1);
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
    if (isPrepareInTickEnabled()) {
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
      const items = await fetchDueCandidates(db, campaign.id, batchSize);
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
        items,
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
      run: async (item, ctx) => {
        const entry = plannedById.get(ctx.campaignId);
        if (!entry) return;
        let signal = null as BackoffReason | null;
        let pauseCampaign = false;
        try {
          const outcome = await processQueueItem(item, entry.campaign, {
            defaultMaxInFlight: channelWork.defaultMaxInFlight.get(ctx.channelId),
            channelConfig: channelConfigFor(channelWork.configs, ctx.channelId, entry.campaign.account_id),
            blacklistLookup,
            onProviderCall: (observation) => {
              telemetry.recordProviderCall(observation.provider, observation.latencyMs, observation.code);
              signal = observation.signal ?? signal;
            },
          });
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
    if (!lostLease && Date.now() < stopAt - 5_000) await drainCallbackOutbox();
    await cleanupOrphanReceipts(db, stopAt, () => lostLease);
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
