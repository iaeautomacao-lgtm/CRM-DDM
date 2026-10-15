// Worker de ENVIO do Disparador (W3 do desenho prd-v2/disparador-4800-pronto.md; PRD 12 §6.5).
//
// Um processo Node que roda em QUALQUER máquina com só Node + variáveis de ambiente (bundle único: scripts/build-worker.mjs). Ele é dono
// de alguns números Meta (lease com TTL no banco, migration 367) e os envia com o MESMO estágio de envio do cron (send-stage.ts):
// agendador por número, claim em lote com fencing do lease e balde durável por número (migration 368), confirmação em micro-lote.
//
// O que o worker NÃO faz (fica com o cron, por desenho): planejamento de campanha (janela já é checada aqui, mas cadência de campanha
// SEQUENCIAL, reflow, encerramento da campanha e manutenção). O cron continua funcionando sozinho quando NENHUM worker está ativo:
// a chave worker_enabled (engine-flags.ts, padrão DESLIGADA) e o lease vivo é que fazem o cron pular um número.
//
// Parada limpa (SIGTERM): para de iniciar envios, espera os em voo (shutdown-gate), drena as confirmações em micro-lote e EXPIRA os leases
// (outro worker ou o cron assume). Crash: o lease vence em ≤ 30 s; itens em voo ficam 'enviando' e o watchdog os fecha como incertos (nunca reenvia).
import type { SupabaseClient } from "@supabase/supabase-js";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { loadEngineFlagRows, resolveEngineFlag } from "@/lib/disparador/engine-flags";
import { LEASE_RENEW_EVERY_MS, LEASE_TTL_SECONDS, loadLiveWorkerSessions } from "@/lib/disparador/worker-ownership";
import { runSendStage, type PlannedCampaign, type SendStageInput } from "@/lib/disparador/send-stage";
import { planClaimTokens } from "@/lib/disparador/batch-claim";
import { canSendNow } from "@/lib/disparador/send-window";
import { checkCampaignAutoPause, autoPauseConfigFromEnv } from "@/lib/disparador/auto-pause";
import { resolveThroughputConfig } from "@/lib/disparador/throughput-config";
import { WORKER_MAX_PROCESS_CONCURRENCY } from "@/lib/disparador/concurrency";
import { TickTelemetry, startHealthMonitor } from "@/lib/disparador/dispatch-telemetry";
import { resolveCronBatchCandidateLimit, resolveCronCandidateCap, shouldReserveCampaignCadence } from "@/lib/disparador/cron-batching";
import { mapWithConcurrency, resolvePlanConcurrency } from "@/lib/disparador/plan-concurrency";
import { beginShutdown } from "@/lib/disparador/shutdown-gate";
import type { Campaign } from "@/lib/disparador/processQueue";
import { recordCronHeartbeat } from "@/lib/ops/cron-heartbeat";
import { writeLog } from "@/lib/logger";
import { formatWorkerEvent } from "./log";

type Env = Record<string, string | undefined>;
type Db = SupabaseClient;

export const WORKER_VERSION = "w3";

export interface WorkerConfig {
  /** Identificador deste processo no lease (único por processo vivo). */
  owner: string;
  /** Grupo (DISPATCH_WORKER_GROUP). Vazio = auto: pega número sem grupo definido. */
  group: string | null;
  /** Máximo de números por processo (padrão 2). */
  maxNumbers: number;
  ttlSeconds: number;
  renewEveryMs: number;
  /** Espera entre rodadas sem trabalho. */
  idleMs: number;
  /** Teto de uma rodada de envio (depois disso para de iniciar e replaneja). */
  roundBudgetMs: number;
  /** Tempo máximo esperando envios em voo no SIGTERM. */
  drainMs: number;
  heartbeatEveryMs: number;
  /** A cada quanto escreve a linha dispatch_worker_tick. */
  tickLogEveryMs: number;
}

const int = (raw: string | undefined, def: number, min: number, max: number) => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

export function resolveWorkerConfig(env: Env = process.env): WorkerConfig {
  const group = (env.DISPATCH_WORKER_GROUP ?? "").trim();
  return {
    owner: (env.DISPATCH_WORKER_ID ?? "").trim() || `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    group: group || null,
    maxNumbers: int(env.DISPATCH_WORKER_MAX_NUMBERS, 2, 1, 10),
    ttlSeconds: LEASE_TTL_SECONDS,
    renewEveryMs: LEASE_RENEW_EVERY_MS,
    idleMs: int(env.DISPATCH_WORKER_IDLE_MS, 1_000, 100, 10_000),
    roundBudgetMs: int(env.DISPATCH_WORKER_ROUND_MS, 20_000, 2_000, 50_000),
    drainMs: int(env.DISPATCH_WORKER_DRAIN_MS, 8_000, 1_000, 30_000),
    heartbeatEveryMs: 30_000,
    tickLogEveryMs: 15_000,
  };
}

export type WorkerLog = (event: string, payload: Record<string, unknown>) => void;

export interface WorkerDeps {
  db: Db;
  env?: Env;
  config?: WorkerConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: WorkerLog;
  /** Injetável nos testes; padrão = o estágio de envio do cron. */
  sendStage?: (input: SendStageInput) => ReturnType<typeof runSendStage>;
  /** Heartbeat global (cron_heartbeat); injetável nos testes. */
  heartbeat?: (durationMs: number) => Promise<void>;
  /** Linha de telemetria (system_logs); injetável nos testes. */
  writeTick?: (payload: Record<string, unknown>) => Promise<void>;
}

export interface RoundResult {
  /** Houve trabalho planejado nesta rodada. */
  worked: boolean;
  owned: string[];
  sent: number;
  failed: number;
  reason?: "flag_off" | "no_numbers" | "nothing_due" | "stopping";
}

interface CampaignRow extends Campaign {
  session_ids?: string[] | null;
}

const CAMPAIGN_COLUMNS = "id, account_id, status, janela_inicio, janela_fim, dias_envio, batch_size, batch_pause_seconds, limite_por_hora, session_ids";

const isMissingFunction = (error: { code?: string } | null | undefined) => error?.code === "PGRST202" || error?.code === "42883";

export class MigrationRequiredError extends Error {
  constructor(what: string) {
    super(`Migration ausente para o worker: ${what} (aplique a 367 e a 368)`);
    this.name = "MigrationRequiredError";
  }
}

export class DispatchWorker {
  readonly config: WorkerConfig;
  private readonly db: Db;
  private readonly env: Env;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: WorkerLog;
  private readonly sendStage: NonNullable<WorkerDeps["sendStage"]>;
  private readonly heartbeat: NonNullable<WorkerDeps["heartbeat"]>;
  private readonly writeTick: NonNullable<WorkerDeps["writeTick"]>;

  private owned = new Set<string>();
  private stopping = false;
  private loop: Promise<void> | null = null;
  private lastRenewAt = 0;
  private lastHeartbeatAt = 0;
  private lastTickLogAt = 0;
  private acc = { sent: 0, failed: 0, since: 0, peakInFlight: 0 };
  private lastStats: Record<string, unknown> = {};

  constructor(deps: WorkerDeps) {
    this.db = deps.db;
    this.env = deps.env ?? process.env;
    this.config = deps.config ?? resolveWorkerConfig(this.env);
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = deps.log ?? ((event, payload) => console.log(formatWorkerEvent(event, payload)));
    this.sendStage = deps.sendStage ?? runSendStage;
    this.heartbeat =
      deps.heartbeat ?? (async (durationMs) => recordCronHeartbeat("dispatch_worker", { status: "ok", durationMs }, this.db as never));
    this.writeTick =
      deps.writeTick ??
      (async (payload) => {
        await writeLog({ level: "info", source: "disparador", event: "dispatch_worker_tick", message: "Tick do worker de envio", payload });
      });
    this.acc.since = this.now();
  }

  ownedSessions(): string[] {
    return [...this.owned].sort();
  }

  isStopping(): boolean {
    return this.stopping;
  }

  /** Laço principal: roda até stop(). Erro de migration ausente derruba o processo (o operador precisa agir); o resto é logado e tentado de novo. */
  run(): Promise<void> {
    if (!this.loop) this.loop = this.main();
    return this.loop;
  }

  private async main(): Promise<void> {
    this.log("dispatch_worker_boot", { owner: this.config.owner, group: this.config.group, max_numbers: this.config.maxNumbers, version: WORKER_VERSION });
    while (!this.stopping) {
      const startedAt = this.now();
      let result: RoundResult | null = null;
      try {
        result = await this.round();
      } catch (error) {
        if (error instanceof MigrationRequiredError) {
          this.log("dispatch_worker_migration_required", { message: error.message });
          throw error;
        }
        this.log("dispatch_worker_round_error", { message: error instanceof Error ? error.message : String(error) });
      }
      await this.maybeHeartbeat(startedAt);
      if (this.stopping) break;
      await this.sleep(result?.worked ? 50 : this.config.idleMs);
    }
  }

  private async maybeHeartbeat(startedAt: number): Promise<void> {
    const now = this.now();
    if (now - this.lastHeartbeatAt < this.config.heartbeatEveryMs) return;
    this.lastHeartbeatAt = now;
    try {
      await this.heartbeat(Math.max(0, now - startedAt));
    } catch {
      /* batimento nunca derruba o worker */
    }
  }

  /** Uma rodada: chave → leases → planejamento → envio. Exportada para testes. */
  async round(): Promise<RoundResult> {
    if (this.stopping) return { worked: false, owned: this.ownedSessions(), sent: 0, failed: 0, reason: "stopping" };

    const flags = await loadEngineFlagRows(this.db, { ttlMs: 5_000, now: this.now() });
    if (!resolveEngineFlag("worker_enabled", flags, this.env).enabled) {
      if (this.owned.size > 0) await this.releaseAll("worker desligado pela chave");
      return { worked: false, owned: [], sent: 0, failed: 0, reason: "flag_off" };
    }

    await this.syncLeases();
    if (this.owned.size === 0) return { worked: false, owned: [], sent: 0, failed: 0, reason: "no_numbers" };

    const planned = await this.plan();
    if (planned.length === 0) return { worked: false, owned: this.ownedSessions(), sent: 0, failed: 0, reason: "nothing_due" };

    const config = resolveThroughputConfig(this.env, { maxGlobalConcurrency: WORKER_MAX_PROCESS_CONCURRENCY });
    const telemetry = new TickTelemetry();
    const health = startHealthMonitor();
    const startedAt = this.now();
    const roundEnd = startedAt + this.config.roundBudgetMs;
    const lost = new Set<string>();
    let schedule;
    let summary: ReturnType<typeof health.summary>;
    try {
      schedule = await this.sendStage({
        db: this.db,
        planned,
        config,
        telemetry,
        batchMode: true,
        outOfTime: () => this.stopping || this.now() > roundEnd || [...this.owned].every((id) => lost.has(id)),
        health,
        autoPauseConfig: autoPauseConfigFromEnv(this.env),
        claimerRated: {
          owner: this.config.owner,
          onLostOwnership: (channelId) => {
            lost.add(channelId);
            this.owned.delete(channelId);
            this.log("dispatch_worker_lease_lost", { session_id: channelId, owner: this.config.owner });
          },
        },
      });
    } finally {
      summary = health.summary();
      health.stop();
    }
    const payload = telemetry.buildPayload({
      durationMs: this.now() - startedAt,
      status: "processed",
      config,
      campaigns: planned.length,
      schedule,
      health: summary,
    }) as { totals?: { sent?: number; failed?: number } };
    const sent = Number(payload.totals?.sent ?? 0);
    const failed = Number(payload.totals?.failed ?? 0);
    this.acc.sent += sent;
    this.acc.failed += failed;
    this.acc.peakInFlight = Math.max(this.acc.peakInFlight, schedule?.globalPeakInFlight ?? 0);
    this.lastStats = {
      in_flight_peak: schedule?.globalPeakInFlight ?? 0,
      event_loop_lag_p99_ms: summary.eventLoopLagP99Ms,
      rss_mb: summary.rssMb,
      version: WORKER_VERSION,
    };
    await this.maybeLogTick(payload);
    return { worked: true, owned: this.ownedSessions(), sent, failed };
  }

  private async maybeLogTick(payload: Record<string, unknown>): Promise<void> {
    const now = this.now();
    if (now - this.lastTickLogAt < this.config.tickLogEveryMs) return;
    const elapsedS = Math.max(1, (now - this.acc.since) / 1000);
    this.lastTickLogAt = now;
    const worker = { owner: this.config.owner, group: this.config.group, owned: this.ownedSessions(), sent_per_s: Math.round((this.acc.sent / elapsedS) * 10) / 10, sent: this.acc.sent, failed: this.acc.failed };
    this.acc = { sent: 0, failed: 0, since: now, peakInFlight: 0 };
    this.lastStats = { ...this.lastStats, sent_per_s: worker.sent_per_s };
    try {
      await this.writeTick({ ...payload, worker });
    } catch {
      /* telemetria nunca derruba o worker */
    }
  }

  // ── leases ──────────────────────────────────────────────────────────────

  /** Renova o que já é meu e, havendo espaço, adquire números livres (mode='worker', do meu grupo ou sem grupo, só Meta). */
  private async syncLeases(): Promise<void> {
    const now = this.now();
    if (this.owned.size > 0 && now - this.lastRenewAt >= this.config.renewEveryMs) {
      const before = [...this.owned];
      const { data, error } = await this.db.rpc("renew_dispatch_leases", {
        p_owner: this.config.owner,
        p_session_ids: before,
        p_ttl_seconds: this.config.ttlSeconds,
        p_stats: Object.keys(this.lastStats).length ? this.lastStats : null,
      });
      if (error) {
        if (isMissingFunction(error)) throw new MigrationRequiredError("renew_dispatch_leases");
        throw new Error(`falha ao renovar leases: ${error.message}`);
      }
      const kept = new Set(Array.isArray(data) ? (data as string[]) : []);
      for (const id of before) {
        if (!kept.has(id)) {
          this.owned.delete(id);
          this.log("dispatch_worker_lease_lost", { session_id: id, owner: this.config.owner });
        }
      }
      this.lastRenewAt = now;
    }
    const room = this.config.maxNumbers - this.owned.size;
    if (room <= 0) return;
    const candidates = await this.candidateSessions();
    if (candidates.length === 0) return;
    const live = await loadLiveWorkerSessions(this.db);
    const free = candidates.filter((id) => !this.owned.has(id) && !live.has(id)).slice(0, room);
    if (free.length === 0) return;
    const { data, error } = await this.db.rpc("acquire_dispatch_leases", { p_owner: this.config.owner, p_session_ids: free, p_ttl_seconds: this.config.ttlSeconds });
    if (error) {
      if (isMissingFunction(error)) throw new MigrationRequiredError("acquire_dispatch_leases");
      throw new Error(`falha ao adquirir leases: ${error.message}`);
    }
    for (const id of Array.isArray(data) ? (data as string[]) : []) {
      this.owned.add(id);
      this.log("dispatch_worker_lease_acquired", { session_id: id, owner: this.config.owner });
    }
    if (this.owned.size > 0 && this.lastRenewAt === 0) this.lastRenewAt = now;
  }

  /** Números que este worker pode assumir: ownership mode='worker' (sem grupo ou do meu grupo), canal Meta habilitado. Ordem estável. */
  private async candidateSessions(): Promise<string[]> {
    const { data, error } = await this.db.from("dispatch_channel_ownership").select("session_id, worker_group").eq("mode", "worker");
    if (error) {
      if (error.code === "42P01" || error.code === "PGRST205" || /does not exist|schema cache/i.test(error.message)) throw new MigrationRequiredError("dispatch_channel_ownership");
      throw new Error(`falha ao ler ownership: ${error.message}`);
    }
    const rows = ((data ?? []) as Array<{ session_id: string; worker_group: string | null }>).filter((r) => !r.worker_group || r.worker_group === this.config.group);
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.session_id);
    const { data: configs, error: configError } = await this.db.from("whatsapp_config").select("id, provider, habilitado").in("id", ids);
    if (configError) throw new Error(`falha ao ler canais: ${configError.message}`);
    const ok = new Set(((configs ?? []) as Array<{ id: string; provider: string | null; habilitado: boolean | null }>).filter((c) => c.provider === "meta" && c.habilitado !== false).map((c) => c.id));
    return ids.filter((id) => ok.has(id)).sort();
  }

  // ── planejamento (só o que o worker faz; o resto é do cron) ─────────────

  private async plan(): Promise<PlannedCampaign[]> {
    const { data, error } = await this.db.from("campaigns").select(CAMPAIGN_COLUMNS).eq("status", "em_execucao").order("next_batch_at", { ascending: true, nullsFirst: true });
    if (error) throw new Error(`falha ao ler campanhas: ${error.message}`);
    const config = resolveThroughputConfig(this.env, { maxGlobalConcurrency: WORKER_MAX_PROCESS_CONCURRENCY });
    const cap = resolveCronCandidateCap(config);
    const autoPause = autoPauseConfigFromEnv(this.env);
    const owned = new Set(this.owned);
    const campaigns = ((data ?? []) as unknown as CampaignRow[]).filter((c) => !Array.isArray(c.session_ids) || c.session_ids.some((id) => owned.has(id)));
    const planOne = async (campaign: CampaignRow): Promise<PlannedCampaign | null> => {
      if (this.stopping) return null;
      // Campanha sequencial (cadência por reserve_campaign_tick) é do cron; o cron também só pula números do worker para campanha em lote.
      if (shouldReserveCampaignCadence(campaign.batch_size)) return null;
      if (!canSendNow({ inicio: campaign.janela_inicio, fim: campaign.janela_fim, dias: campaign.dias_envio }, new Date(this.now()))) return null;
      if (await checkCampaignAutoPause(this.db, campaign, autoPause)) return null;
      const limit = resolveCronBatchCandidateLimit(campaign.batch_size, cap);
      const plan = await planClaimTokens(this.db, campaign.id, limit, new Date(this.now()).toISOString());
      if (plan === null) throw new MigrationRequiredError("count_due_dispatch_items (migration 188)");
      const tokens = plan.tokens.filter((t) => t.session_id && owned.has(t.session_id));
      if (tokens.length === 0) return null;
      return { campaign, items: tokens, result: { campaign_id: campaign.id, sent: 0, pending_confirmation: 0 } };
    };
    const planned = await mapWithConcurrency(campaigns, resolvePlanConcurrency(this.env), planOne);
    return planned.filter((p): p is PlannedCampaign => !!p);
  }

  // ── parada ──────────────────────────────────────────────────────────────

  /** SIGTERM: para de iniciar envios, espera os em voo, drena as confirmações e expira os leases. Nunca lança. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log("dispatch_worker_stopping", { owner: this.config.owner, owned: this.ownedSessions() });
    try {
      await beginShutdown(this.config.drainMs);
    } catch {
      /* segue para liberar os leases */
    }
    if (this.loop) await Promise.race([this.loop.catch(() => undefined), this.sleep(2_000)]);
    await this.releaseAll("shutdown");
    this.log("dispatch_worker_shutdown", { owner: this.config.owner });
  }

  private async releaseAll(reason: string): Promise<void> {
    if (this.owned.size === 0) return;
    const ids = [...this.owned];
    this.owned.clear();
    try {
      const { data, error } = await this.db.rpc("release_dispatch_leases", { p_owner: this.config.owner });
      if (error) this.log("dispatch_worker_release_failed", { reason, message: error.message });
      else this.log("dispatch_worker_released", { reason, sessions: ids, released: Number(data) || 0 });
    } catch (error) {
      this.log("dispatch_worker_release_failed", { reason, message: error instanceof Error ? error.message : String(error) });
    }
  }
}
