// Um "worker" da bancada: processo Node próprio que faz o que o worker de envio faz entre o claim e a confirmação, com o código REAL de produção:
// leases (acquire/renew com fencing do dono), planejamento por fichas (count_due), agendador por número (runDispatchSchedule: vagas derivadas do
// limite/s + balde em memória), claim em lote com balde durável (claim_dispatch_batch_rated) e confirmação em micro-lote (ConfirmBatcher).
// O que NÃO entra (fica fora por custo): processQueueItem (montagem do template, decifrar token, PostgREST). O envio é um fetch real
// (HTTP/1.1 keep-alive, corpo de template) contra a Meta simulada; então a CPU medida aqui é um PISO do worker real.
// Lançado por run.ts via fork(); fala com ele por IPC (mensagens `result`). Nunca toca Supabase nem a Meta real: só 127.0.0.1.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { BenchDb } from "./db-client";
import { runDispatchSchedule, type ChannelWork } from "@/lib/disparador/dispatch-scheduler";
import { ChannelClaimer, planClaimTokens } from "@/lib/disparador/batch-claim";
import { ConfirmBatcher, type ConfirmResult } from "@/lib/disparador/confirm-batcher";
import { derivedSlots } from "@/lib/disparador/channel-rate";
import { resolveThroughputConfig } from "@/lib/disparador/throughput-config";
import { WORKER_MAX_PROCESS_CONCURRENCY } from "@/lib/disparador/concurrency";
import { resolveCronBatchCandidateLimit, resolveCronCandidateCap } from "@/lib/disparador/cron-batching";
import { drainClaimLatencies } from "@/lib/disparador/claim-latency";
import { startHealthMonitor } from "@/lib/disparador/dispatch-telemetry";
import type { QueueItem } from "@/lib/disparador/processQueue";

export interface WorkerBenchConfig {
  dbPort: number;
  metaUrl: string;
  owner: string;
  /** número (session_id) → campanha (uma por número). */
  numbers: Array<{ sessionId: string; campaignId: string }>;
  ratePerSecond: number;
  /** Instante (ms epoch) em que a contagem de segundos começa; igual para todos os workers. */
  t0: number;
  warmupS: number;
  durationS: number;
  roundMs: number;
  batchSize: number;
}

export interface WorkerBenchResult {
  owner: string;
  numbers: string[];
  /** Envios INICIADOS por segundo (desde t0), por número: o que a Meta recebeu. */
  perSecond: Record<string, number[]>;
  claimMs: number[];
  confirmMs: number[];
  cpu: { cpuMs: number; wallMs: number };
  rssMaxMb: number;
  lag: { p50Ms: number; p99Ms: number; maxMs: number };
  counts: { started: number; ok: number; confirmed: number; httpErrors: Record<string, number>; timeouts: number; confirmErrors: number };
  rounds: { count: number; meanMs: number; gapMsTotal: number; tokensPlanned: number };
  slotsPerNumber: number;
  globalConcurrency: number;
  leasesLost: string[];
}

const cfg = JSON.parse(process.env.BENCH_WORKER ?? "null") as WorkerBenchConfig | null;
if (!cfg) throw new Error("BENCH_WORKER ausente");
const loopback = new URL(cfg.metaUrl);
if (loopback.hostname !== "127.0.0.1" && loopback.hostname !== "localhost") throw new Error(`a bancada só fala com a Meta simulada local, recebeu ${loopback.hostname}`);

const BARRIER = process.env.BENCH_BARRIER === "1";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const secondsSinceT0 = (now = Date.now()) => Math.floor((now - cfg.t0) / 1000);
const TEMPLATE_BODY = (to: string) =>
  JSON.stringify({
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: "cobranca_acordo_v3",
      language: { code: "pt_BR" },
      components: [{ type: "body", parameters: [{ type: "text", text: "Maria da Silva" }, { type: "text", text: "R$ 1.234,56" }, { type: "text", text: "15/10/2026" }] }],
    },
  });

async function main() {
  const db = await BenchDb.connect(cfg!.dbPort);
  const sessionIds = cfg!.numbers.map((n) => n.sessionId);
  const campaignOf = new Map(cfg!.numbers.map((n) => [n.sessionId, n.campaignId] as const));

  // As mesmas variáveis do worker real: o teto global do processo é WORKER_MAX_PROCESS_CONCURRENCY (400); a concorrência vem do ambiente.
  const throughput = resolveThroughputConfig(process.env, { maxGlobalConcurrency: WORKER_MAX_PROCESS_CONCURRENCY });
  const slots = derivedSlots(cfg!.ratePerSecond, 1, 150);
  const planLimit = resolveCronBatchCandidateLimit(cfg!.batchSize, resolveCronCandidateCap(throughput));

  const leases = await db.rpc("acquire_dispatch_leases", { p_owner: cfg!.owner, p_session_ids: sessionIds, p_ttl_seconds: 30 });
  if (leases.error) throw new Error(`acquire_dispatch_leases: ${leases.error.message}`);
  const owned = new Set<string>((leases.data as string[]) ?? []);
  if (owned.size !== sessionIds.length) throw new Error(`lease parcial: ${owned.size}/${sessionIds.length}`);
  const leasesLost: string[] = [];
  const renew = setInterval(() => {
    void db.rpc("renew_dispatch_leases", { p_owner: cfg!.owner, p_session_ids: [...owned], p_ttl_seconds: 30, p_stats: null }).then((res) => {
      const kept = new Set<string>((res.data as string[]) ?? []);
      for (const id of [...owned]) if (!kept.has(id)) { owned.delete(id); leasesLost.push(id); };
    });
  }, 10_000);

  const perSecond: Record<string, number[]> = Object.fromEntries(sessionIds.map((id) => [id, [] as number[]]));
  const counts = { started: 0, ok: 0, confirmed: 0, httpErrors: {} as Record<string, number>, timeouts: 0, confirmErrors: 0 };
  const confirmMs: number[] = [];
  const roundDurations: number[] = [];
  let gapMsTotal = 0;
  let tokensPlanned = 0;
  let rssMaxMb = 0;
  const lag = monitorEventLoopDelay({ resolution: 10 });
  const rssTimer = setInterval(() => (rssMaxMb = Math.max(rssMaxMb, process.memoryUsage().rss / 1048576)), 500);

  let cpuStart: NodeJS.CpuUsage | null = null;
  let wallStart = 0;
  let cpuEnd: NodeJS.CpuUsage | null = null;
  let wallEnd = 0;
  const warmupEndAt = cfg!.t0 + cfg!.warmupS * 1000;
  const endAt = warmupEndAt + cfg!.durationS * 1000;
  const mark = setInterval(() => {
    const now = Date.now();
    if (!cpuStart && now >= warmupEndAt) {
      cpuStart = process.cpuUsage();
      wallStart = now;
      lag.reset();
      lag.enable();
      drainClaimLatencies();
      confirmMs.length = 0;
      rssMaxMb = 0;
    }
    if (!cpuEnd && now >= endAt) {
      const delta = process.cpuUsage(cpuStart ?? undefined);
      cpuEnd = delta;
      wallEnd = now;
      lag.disable();
    }
  }, 100);

  // Espera o t0 comum (todos os workers começam juntos).
  await sleep(Math.max(0, cfg!.t0 - Date.now()));

  let claimSamples: number[] = [];
  const tails = new Set<Promise<void>>();
  // Igual ao DispatchWorker.round: UM estágio por número; a rodada de um número só espera o orçamento de INÍCIO (ou o fim do estágio), e a cauda
  // em voo (timeout da Meta) termina em segundo plano, sem segurar o planejamento seguinte nem os outros números. BENCH_BARRIER=1 volta ao
  // comportamento antigo (um estágio para todos os números, esperando o último envio em voo) para medir o antes/depois.
  const stage = async (ids: string[], plans: Array<{ id: string; tokens: QueueItem[] }>, roundEnd: number) => {
    const channels: ChannelWork<QueueItem>[] = plans.map(({ id, tokens }) => ({
      channelId: id,
      maxConcurrency: slots,
      ratePerSecond: cfg!.ratePerSecond,
      campaigns: [{ campaignId: campaignOf.get(id)!, items: tokens }],
    }));
    const claimer = new ChannelClaimer({
      db: db as never,
      defaultMaxInFlight: () => slots,
      rated: { owner: cfg!.owner, rateFor: () => cfg!.ratePerSecond, onLostOwnership: (id) => (owned.delete(id), leasesLost.push(id)) },
    });
    const batcher = new ConfirmBatcher({ db: db as never, single: async () => ({ error: { message: "sem confirmação unitária na bancada" }, replayed: false }) });
    const health = startHealthMonitor();
    try {
      await runDispatchSchedule<QueueItem>({
        channels,
        globalConcurrency: throughput.globalConcurrency,
        shouldStop: () => Date.now() > Math.min(roundEnd, endAt) || ids.every((id) => !owned.has(id)),
        adaptiveBackoff: throughput.adaptiveBackoff,
        sampleHealth: () => health.sample(),
        maxEventLoopLagMs: throughput.maxEventLoopLagMs,
        maxRssMb: throughput.maxRssMb,
        run: async (_token, ctx) => {
          const claimed = await claimer.next(ctx.channelId, ctx.campaignId, ctx.slotsFree);
          if (!claimed) return;
          const item = claimed.item;
          const second = secondsSinceT0();
          if (second >= 0) perSecond[ctx.channelId][second] = (perSecond[ctx.channelId][second] ?? 0) + 1;
          counts.started++;
          let providerId: string | null = null;
          try {
            const res = await fetch(`${cfg!.metaUrl}/v21.0/${ctx.channelId}/messages`, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: "Bearer token-ficticio" },
              body: TEMPLATE_BODY(String(item.mensagem_final ?? "")),
              signal: AbortSignal.timeout(10_000),
            });
            if (res.ok) {
              const body = (await res.json()) as { messages?: Array<{ id?: string }> };
              providerId = body.messages?.[0]?.id ?? null;
            } else {
              await res.arrayBuffer();
              counts.httpErrors[String(res.status)] = (counts.httpErrors[String(res.status)] ?? 0) + 1;
            }
          } catch {
            counts.timeouts++;
          }
          if (!providerId) {
            // Falha do provedor: devolve o item à fila (no worker real o caminho de erro tem outras RPCs; aqui 1, como piso).
            await db.rpc("unclaim_dispatch_items", { p_ids: [item.id] });
            return { backoff: null };
          }
          counts.ok++;
          const t = performance.now();
          const result: ConfirmResult = await batcher.submit({
            p_item_id: item.id,
            p_campaign_id: ctx.campaignId,
            p_contact_id: (item as { contact_id?: string | null }).contact_id ?? null,
            p_session_id: ctx.channelId,
            p_mensagem: "template cobranca_acordo_v3",
            p_waha_message_id: providerId,
            p_tentativas: item.tentativas ?? 0,
          });
          confirmMs.push(performance.now() - t);
          if (result.error) counts.confirmErrors++;
          else counts.confirmed++;
          return { backoff: null };
        },
      });
    } finally {
      await claimer.releaseLeftovers();
      await batcher.drain();
      health.stop();
    }
  };

  const roundsOf = async (ids: string[]) => {
    let lastRoundEnd = Date.now();
    while (Date.now() < endAt + 2_000) {
      const roundStart = Date.now();
      gapMsTotal += roundStart - lastRoundEnd;
      // Planejamento (como o worker): uma contagem de vencidos por campanha → fichas.
      const plans = (
        await Promise.all(ids.map(async (id) => ({ id, plan: await planClaimTokens(db as never, campaignOf.get(id)!, planLimit, new Date().toISOString()) })))
      )
        .filter(({ id, plan }) => plan && plan.tokens.length > 0 && owned.has(id))
        .map(({ id, plan }) => ({ id, tokens: plan!.tokens }));
      if (plans.length === 0) break; // fila vazia: a bancada semeia com folga, então isto é fim de teste
      for (const p of plans) tokensPlanned += p.tokens.length;
      const roundEnd = roundStart + cfg!.roundMs;
      const run = stage(ids, plans, roundEnd);
      const tail = run.then(
        () => undefined,
        (error) => console.error(`[worker-bench ${cfg!.owner}]`, error),
      );
      tails.add(tail);
      void tail.then(() => tails.delete(tail));
      if (BARRIER) await tail;
      else await Promise.race([tail, sleep(Math.max(0, Math.min(roundEnd, endAt) - Date.now()) + 50)]);
      lastRoundEnd = Date.now();
      roundDurations.push(lastRoundEnd - roundStart);
      if (Date.now() >= endAt) break;
    }
  };
  // Padrão: um laço independente por número. BENCH_BARRIER=1: um laço só para todos os números do processo, esperando o fim de cada rodada.
  await Promise.all(BARRIER ? [roundsOf(sessionIds)] : sessionIds.map((id) => roundsOf([id])));
  await Promise.allSettled([...tails]);
  claimSamples = drainClaimLatencies();

  clearInterval(renew);
  clearInterval(mark);
  clearInterval(rssTimer);
  await db.rpc("release_dispatch_leases", { p_owner: cfg!.owner });
  db.close();
  const cpu = cpuEnd as NodeJS.CpuUsage | null;
  const result: WorkerBenchResult = {
    owner: cfg!.owner,
    numbers: sessionIds,
    perSecond,
    claimMs: claimSamples,
    confirmMs,
    cpu: { cpuMs: cpu ? (cpu.user + cpu.system) / 1000 : 0, wallMs: wallEnd - wallStart },
    rssMaxMb,
    lag: { p50Ms: lag.percentile(50) / 1e6, p99Ms: lag.percentile(99) / 1e6, maxMs: lag.max / 1e6 },
    counts,
    rounds: { count: roundDurations.length, meanMs: roundDurations.length ? roundDurations.reduce((a, b) => a + b, 0) / roundDurations.length : 0, gapMsTotal, tokensPlanned },
    slotsPerNumber: slots,
    globalConcurrency: throughput.globalConcurrency,
    leasesLost,
  };
  process.send?.({ type: "result", result }, () => process.exit(0));
}

main().catch((error) => {
  console.error(`[worker-bench ${cfg?.owner}]`, error);
  process.exit(1);
});
