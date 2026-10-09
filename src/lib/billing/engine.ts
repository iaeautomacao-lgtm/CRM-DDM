import "server-only";
// PRD 17, PR 17.3 — o motor da régua de cobrança (um tick stateless; o cron /api/billing/cron só o chama).
//
// Por conta com régua ativa, em ordem:
//   1. PARADA   opt-out/blacklist em lote (billing_stop_blacklisted); acordo fechado no CRM já para por trigger (migration 278)
//   2. INSCRIÇÃO billing_enroll_open_debts por régua (dry-run também inscreve: é assim que se mede)
//   3. PRÉ-CONFERÊNCIA  precheckUpcoming: consulta à fonte (DDM) das dívidas com etapa nas próximas 24 h
//   4. DRY-RUN  régua em dry_run só CONTA o que sairia hoje (billing_dry_run) — nunca reserva nem envia
//   5. LIVE     régua ligada e fora do dry-run: claim (SKIP LOCKED + UNIQUE) → conferência na fonte → billing_should_send (3ª rede) →
//               entrega ao disparador pelo `enqueuer` (PR 17.4). SEM enqueuer ou SEM fonte configurada o motor NÃO reserva nada
//               (fail-closed): reservar sem poder enviar/conferir deixaria etapas presas.
// Falha da fonte ADIA (a reserva é desfeita e a inscrição volta a tentar); nunca "envia por precaução".
// Nunca loga CPF, telefone ou texto: só contagens e ids.
import type { SupabaseClient } from "@supabase/supabase-js";

import { writeLog } from "@/lib/logger";

import { checkDebtById, enrollOpenDebts, precheckUpcoming, type PrecheckSummary } from "./sync";
import type { DebtSource } from "./debt-source";

type Db = Pick<SupabaseClient, "from" | "rpc">;

export interface ClaimedStep {
  send_id: string;
  enrollment_id: string;
  step_id: string;
  account_id: string;
  ruler_id: string;
  debt_id: string;
  contact_id: string;
  channel_id: string | null;
  send_key: string;
  due_at: string;
  template_id: string | null;
  message_text: string | null;
  due_date: string;
  amount_cents: number | null;
  external_ref: string;
}

export interface EnqueueResult {
  sendId: string;
  /** id do item na fila do disparador (sucesso). */
  queueItemId?: string;
  /** motivo curto (falha) — a reserva é desfeita e tenta de novo. */
  error?: string;
}

/** Entrega ao disparador (PR 17.4): campanha-sistema `origem='regua'`, mesma fila, mesma janela/qualidade/blacklist/pausa. */
export interface BillingEnqueuer {
  enqueue(accountId: string, steps: ClaimedStep[]): Promise<EnqueueResult[]>;
}

export interface BillingDeps {
  db: Db;
  /** Fonte da conta (já com o teto de consultas). null = sem token/fonte: nada ao vivo. */
  sourceFor: (accountId: string) => DebtSource | null;
  enqueuer: BillingEnqueuer | null;
  now?: () => Date;
}

export interface TickSummary {
  accounts: number;
  rulers: number;
  stopped_blacklist: number;
  enrolled: number;
  precheck: PrecheckSummary;
  dry_run: Record<string, number>;
  live: { claimed: number; enqueued: number; cancelled: number; released: number };
  skipped_live_no_enqueuer: number;
  skipped_live_no_source: number;
  errors: number;
}

/** Atraso até a inscrição tentar de novo quando a fonte falha / o enqueue falha. */
export const RETRY_SOURCE_MS = 15 * 60_000;
export const RETRY_ENQUEUE_MS = 5 * 60_000;
const MAX_LIVE_BATCHES = 5;

const emptySummary = (): TickSummary => ({
  accounts: 0,
  rulers: 0,
  stopped_blacklist: 0,
  enrolled: 0,
  precheck: { candidates: 0, checked: 0, stopped: 0, deferred: 0, fresh: 0 },
  dry_run: {},
  live: { claimed: 0, enqueued: 0, cancelled: 0, released: 0 },
  skipped_live_no_enqueuer: 0,
  skipped_live_no_source: 0,
  errors: 0,
});

/** Data civil de Brasília (UTC-3 fixo). */
export function brasiliaDate(now: Date): string {
  return new Date(now.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
}

async function cancelSend(db: Db, sendId: string, reason: string, now: Date): Promise<void> {
  const { error } = await db
    .from("billing_step_sends")
    .update({ status: "cancelled", error_code: reason.slice(0, 100), updated_at: now.toISOString() })
    .eq("id", sendId)
    .in("status", ["reserved", "enqueued"]);
  if (error) throw error;
}

/** Desfaz a reserva (nada saiu) e agenda nova tentativa: o UNIQUE (inscrição, etapa) volta a ficar livre. */
async function releaseSend(db: Db, step: ClaimedStep, retryInMs: number, now: Date): Promise<void> {
  const { error } = await db.from("billing_step_sends").delete().eq("id", step.send_id).eq("status", "reserved");
  if (error) throw error;
  const { error: updateError } = await db
    .from("billing_enrollments")
    .update({ next_step_at: new Date(now.getTime() + retryInMs).toISOString(), updated_at: now.toISOString() })
    .eq("id", step.enrollment_id)
    .eq("status", "active");
  if (updateError) throw updateError;
}

async function markEnqueued(db: Db, sendId: string, queueItemId: string, now: Date): Promise<void> {
  const { error } = await db
    .from("billing_step_sends")
    .update({ status: "enqueued", queue_item_id: queueItemId, updated_at: now.toISOString() })
    .eq("id", sendId)
    .eq("status", "reserved");
  if (error) throw error;
}

async function runLive(deps: BillingDeps, accountId: string, source: DebtSource, claimLimit: number, now: Date, summary: TickSummary): Promise<void> {
  const { db, enqueuer } = deps;
  if (!enqueuer) return;
  for (let batch = 0; batch < MAX_LIVE_BATCHES; batch++) {
    const { data, error } = await db.rpc("billing_claim_due_steps", { p_account: accountId, p_limit: claimLimit, p_now: now.toISOString() });
    if (error) throw error;
    const claimed = (data ?? []) as ClaimedStep[];
    if (claimed.length === 0) return;
    summary.live.claimed += claimed.length;

    const verified: ClaimedStep[] = [];
    let sourceDown = false;
    for (const step of claimed) {
      if (sourceDown) {
        await releaseSend(db, step, RETRY_SOURCE_MS, now);
        summary.live.released++;
        continue;
      }
      const decision = await checkDebtById(db, source, accountId, step.debt_id, { now });
      if (!decision.send) {
        if (decision.reason !== "source_unavailable") {
          await cancelSend(db, step.send_id, decision.reason, now);
          summary.live.cancelled++;
        } else {
          await releaseSend(db, step, RETRY_SOURCE_MS, now);
          summary.live.released++;
          if (decision.retryable) sourceDown = true; // limite/queda: não insiste neste tick
        }
        continue;
      }
      const { data: guard, error: guardError } = await db.rpc("billing_should_send", { p_send_id: step.send_id });
      if (guardError) throw guardError;
      if ((guard as { ok?: boolean } | null)?.ok === true) verified.push(step);
      else summary.live.cancelled++; // a RPC já cancelou a etapa e disse o porquê
    }

    if (verified.length > 0) {
      const results = await enqueuer.enqueue(accountId, verified);
      const byId = new Map(results.map((r) => [r.sendId, r]));
      for (const step of verified) {
        const r = byId.get(step.send_id);
        if (r?.queueItemId && !r.error) {
          await markEnqueued(db, step.send_id, r.queueItemId, now);
          summary.live.enqueued++;
        } else {
          await releaseSend(db, step, RETRY_ENQUEUE_MS, now);
          summary.live.released++;
        }
      }
    }
    if (sourceDown || claimed.length < claimLimit) return;
  }
}

export async function runBillingTick(deps: BillingDeps, options: { budgetMs?: number; claimLimit?: number; accountId?: string } = {}): Promise<TickSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? 50_000;
  const claimLimit = Math.max(1, Math.min(options.claimLimit ?? 200, 1000));
  const summary = emptySummary();

  let query = deps.db.from("billing_rulers").select("id, account_id, dry_run").eq("active", true);
  if (options.accountId) query = query.eq("account_id", options.accountId);
  const { data, error } = await query;
  if (error) throw error;
  const rulers = (data ?? []) as Array<{ id: string; account_id: string; dry_run: boolean }>;
  summary.rulers = rulers.length;

  const byAccount = new Map<string, typeof rulers>();
  for (const r of rulers) byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r]);

  for (const [accountId, accountRulers] of byAccount) {
    if (Date.now() - startedAt >= budgetMs) break;
    summary.accounts++;
    try {
      const { data: stopped, error: stopError } = await deps.db.rpc("billing_stop_blacklisted", { p_account: accountId });
      if (stopError) throw stopError;
      summary.stopped_blacklist += Number(stopped ?? 0);

      for (const ruler of accountRulers) summary.enrolled += await enrollOpenDebts(deps.db, accountId, ruler.id, now);

      const source = deps.sourceFor(accountId);
      if (source) {
        const pre = await precheckUpcoming(deps.db, source, accountId, { now });
        for (const k of Object.keys(pre) as Array<keyof PrecheckSummary>) summary.precheck[k] += pre[k];
      }

      const today = brasiliaDate(now);
      for (const ruler of accountRulers.filter((r) => r.dry_run)) {
        const { data: rows, error: dryError } = await deps.db.rpc("billing_dry_run", { p_account: accountId, p_ruler: ruler.id, p_date: today });
        if (dryError) throw dryError;
        summary.dry_run[ruler.id] = ((rows ?? []) as Array<{ debts: number | string }>).reduce((n, r) => n + Number(r.debts), 0);
      }

      const live = accountRulers.filter((r) => !r.dry_run);
      if (live.length > 0) {
        if (!deps.enqueuer) summary.skipped_live_no_enqueuer++;
        else if (!source) summary.skipped_live_no_source++;
        else await runLive(deps, accountId, source, claimLimit, now, summary);
      }
    } catch (err) {
      summary.errors++;
      void writeLog({
        account_id: accountId,
        level: "error",
        source: "system",
        event: "billing_tick_error",
        message: "Falha no tick da régua de cobrança",
        payload: { erro: err instanceof Error ? err.message.slice(0, 200) : "erro" },
      });
    }
  }

  const activity = summary.stopped_blacklist + summary.enrolled + summary.precheck.checked + summary.live.claimed + summary.live.cancelled + summary.live.released;
  if (activity > 0 || summary.errors > 0) {
    void writeLog({ level: summary.errors ? "warn" : "info", source: "system", event: "billing_tick", message: "Tick da régua de cobrança", payload: { ...summary } });
  }
  return summary;
}

/** Quantas etapas sairiam numa data (dry-run sob demanda; a API da 17.5 usa). Não cria nada. */
export async function previewRuler(db: Db, accountId: string, rulerId: string, date: string): Promise<Array<{ step_id: string; offset_days: number; debts: number }>> {
  const { data, error } = await db.rpc("billing_dry_run", { p_account: accountId, p_ruler: rulerId, p_date: date });
  if (error) throw error;
  return ((data ?? []) as Array<{ step_id: string; offset_days: number; debts: number | string }>).map((r) => ({ ...r, debts: Number(r.debts) }));
}
