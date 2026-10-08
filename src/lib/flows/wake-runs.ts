/* eslint-disable @typescript-eslint/no-explicit-any -- cliente admin com schema wacrm */
// Acordar runs `delayed` (smart_delay) — usado pelo cron de fluxos (PRD 13, IA-07/IA-08).
//
// Garantias (nos dois caminhos):
//   - um run INCONSISTENTE (sem current_node_key, nó inexistente ou sem next_node_key) nunca fica `active`
//     preso: é validado ANTES de ser reivindicado e encerrado de forma controlada (status `error`,
//     end_reason `wake_inconsistent:<problema>`, eventos node_error + run_error);
//   - uma exceção num run (ao carregar nós ou ao avançar) é isolada por run: vira node_error + encerramento
//     controlado do PRÓPRIO run e os demais seguem;
//   - ordem por wake_at ascendente (os mais antigos primeiro).
//
// Caminho padrão (FLOWS_CRON_V2 desligada): a mesma consulta de sempre (lote de 20), agora ordenada.
// Caminho V2 (FLOWS_CRON_V2 ligada + migration 210): RPC wakeable_flow_runs — reivindicação atômica
// (FOR UPDATE SKIP LOCKED), em lotes configuráveis, repetindo até esvaziar ou estourar o orçamento de tempo.
// Sem a função (PGRST202/42883) cai no caminho padrão.
//
// FLOWS_CRON_V2 é flag TEMPORÁRIA de implantação (não é configuração de cliente): depois de aplicada a 210 e
// validada, o padrão vira "ligada" e a env é removida.

import { advanceFromNodeKey, loadAllNodes } from "@/lib/flows/engine";
import type { FlowRunRow, SmartDelayNodeConfig } from "@/lib/flows/types";

type Db = any;

/** Lote do caminho padrão (igual ao de sempre). */
export const WAKE_LEGACY_LIMIT = 20;
export const WAKE_DEFAULT_BATCH = 50;
export const WAKE_MAX_BATCH = 200;
/** Teto de tempo do laço V2 (sobra tempo para o sweep e o vigia da IA no mesmo POST). */
export const WAKE_TIME_BUDGET_MS = 30_000;
const WAKE_MAX_LOOPS = 20;

export function flowsCronV2Enabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = env.FLOWS_CRON_V2?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export interface WakeSummary {
  woken: number;
  failed: number;
  /** Outro cron já reivindicou o run (ou deixou de estar vencido). */
  skipped: number;
  /** Caminho usado: "v2" (RPC) ou "legacy". */
  path: "v2" | "legacy";
}

export type WakeProblem = "no_current_node" | "node_missing" | "no_next_node";

export interface WakeOptions {
  now?: Date;
  v2?: boolean;
  /** Lote do caminho V2 (1..200). */
  batch?: number;
  budgetMs?: number;
  /** Para testes: relógio. */
  clock?: () => number;
}

function isMissingFunction(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === "PGRST202" || error?.code === "42883" || /could not find the function|does not exist/i.test(error?.message ?? "");
}

async function logEvent(db: Db, run: Pick<FlowRunRow, "id" | "flow_id" | "account_id">, event: Record<string, unknown>) {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: run.id,
    flow_id: run.flow_id,
    account_id: run.account_id,
    ...event,
  });
  if (error) console.error("[flows-cron] falha ao gravar evento do run:", run.id, error.message);
}

/**
 * Encerramento controlado de um run que não pode ser acordado. `expectedStatus` protege contra corrida:
 * só encerra se o run ainda está nesse estado.
 */
async function endRun(
  db: Db,
  run: Pick<FlowRunRow, "id" | "flow_id" | "account_id" | "current_node_key">,
  expectedStatus: "delayed" | "active",
  reason: string,
  message: string,
  now: Date,
): Promise<boolean> {
  const { data, error } = await db
    .from("flow_runs")
    .update({ status: "error", ended_at: now.toISOString(), end_reason: reason, wake_at: null })
    .eq("id", run.id)
    .eq("status", expectedStatus)
    .select("id");
  if (error) {
    console.error("[flows-cron] falha ao encerrar o run:", run.id, error.message);
    return false;
  }
  if (!Array.isArray(data) || data.length === 0) return false;
  await logEvent(db, run, {
    node_key: run.current_node_key ?? null,
    node_type: "smart_delay",
    event_type: "node_error",
    status: "error",
    error_message: message,
    payload: { reason, source: "flows_cron" },
  });
  await logEvent(db, run, {
    event_type: "run_error",
    status: "error",
    error_message: message,
    payload: { end_reason: reason, run_status: "error", source: "flows_cron" },
  });
  return true;
}

const PROBLEM_TEXT: Record<WakeProblem, string> = {
  no_current_node: "run em espera sem current_node_key",
  node_missing: "o nó smart_delay do run não existe mais no fluxo",
  no_next_node: "o nó smart_delay não tem next_node_key",
};

/** Avança o run já reivindicado (status active). Qualquer exceção encerra SÓ este run. */
async function resume(db: Db, run: FlowRunRow, nextKey: string, nodes: Map<string, any>, now: Date): Promise<boolean> {
  try {
    await advanceFromNodeKey(db, { ...run, status: "active", wake_at: null }, nextKey, nodes);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[flows-cron] falha ao acordar o run:", run.id, message);
    await endRun(db, run, "active", "wake_exception", `Falha ao retomar o run após o smart_delay: ${message}`, now);
    return false;
  }
}

async function wakeLegacy(db: Db, now: Date): Promise<WakeSummary> {
  const summary: WakeSummary = { woken: 0, failed: 0, skipped: 0, path: "legacy" };
  const { data: delayedRuns, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("status", "delayed")
    .lte("wake_at", now.toISOString())
    .order("wake_at", { ascending: true })
    .limit(WAKE_LEGACY_LIMIT);
  if (error) {
    console.error("[flows-cron] delayed-run scan failed:", error.message);
    return summary;
  }

  for (const run of (delayedRuns ?? []) as FlowRunRow[]) {
    try {
      // 1) Valida ANTES de reivindicar: run inconsistente é encerrado, nunca deixado `active`.
      let problem: WakeProblem | null = null;
      let nextKey: string | null = null;
      let nodes = new Map<string, any>();
      if (!run.current_node_key) {
        problem = "no_current_node";
      } else {
        nodes = await loadAllNodes(db, run.flow_id);
        const delayNode = nodes.get(run.current_node_key);
        if (!delayNode) problem = "node_missing";
        else {
          nextKey = (delayNode.config as unknown as SmartDelayNodeConfig).next_node_key ?? null;
          if (!nextKey) problem = "no_next_node";
        }
      }
      if (problem) {
        const ended = await endRun(db, run, "delayed", `wake_inconsistent:${problem}`, `Run em espera inconsistente: ${PROBLEM_TEXT[problem]}`, now);
        if (ended) summary.failed++;
        else summary.skipped++;
        continue;
      }

      // 2) Reivindica (só quem vira delayed → active retoma; dois crons sobrepostos não acordam o mesmo run).
      const { data: claimed } = await db
        .from("flow_runs")
        .update({ status: "active", wake_at: null })
        .eq("id", run.id)
        .eq("status", "delayed")
        .select("id");
      if (!Array.isArray(claimed) || claimed.length === 0) {
        summary.skipped++;
        continue;
      }

      // 3) O run suspendeu NO smart_delay (mesmo padrão de collect_input/send_buttons): retoma do next_node_key.
      if (await resume(db, run, nextKey as string, nodes, now)) summary.woken++;
      else summary.failed++;
    } catch (err) {
      // Falha ANTES de reivindicar (ex.: carregar os nós): o run continua `delayed` e tenta no próximo tick.
      summary.failed++;
      console.error("[flows-cron] erro ao preparar o run em espera:", run.id, err instanceof Error ? err.message : err);
    }
  }
  return summary;
}

type WakeRow = { run: FlowRunRow; next_node_key: string | null; problem: WakeProblem | null };

async function wakeV2(db: Db, now: Date, options: WakeOptions): Promise<WakeSummary | "missing"> {
  const summary: WakeSummary = { woken: 0, failed: 0, skipped: 0, path: "v2" };
  const batch = Math.min(Math.max(Math.trunc(options.batch ?? WAKE_DEFAULT_BATCH) || WAKE_DEFAULT_BATCH, 1), WAKE_MAX_BATCH);
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.budgetMs ?? WAKE_TIME_BUDGET_MS);

  for (let loop = 0; loop < WAKE_MAX_LOOPS; loop++) {
    if (loop > 0 && clock() > deadline) break;
    const { data, error } = await db.rpc("wakeable_flow_runs", { p_limit: batch });
    if (error) {
      if (isMissingFunction(error) && loop === 0) return "missing";
      console.error("[flows-cron] wakeable_flow_runs falhou:", error.message);
      break;
    }
    const rows = (Array.isArray(data) ? data : []) as WakeRow[];
    if (rows.length === 0) break;

    for (const row of rows) {
      const run = row.run;
      try {
        if (row.problem) {
          const ended = await endRun(db, run, "delayed", `wake_inconsistent:${row.problem}`, `Run em espera inconsistente: ${PROBLEM_TEXT[row.problem] ?? row.problem}`, now);
          if (ended) summary.failed++;
          else summary.skipped++;
          continue;
        }
        const nodes = await loadAllNodes(db, run.flow_id);
        if (await resume(db, run, row.next_node_key as string, nodes, now)) summary.woken++;
        else summary.failed++;
      } catch (err) {
        // O run já foi reivindicado pela RPC (active): encerra de forma controlada, sem derrubar os outros.
        summary.failed++;
        const message = err instanceof Error ? err.message : String(err);
        console.error("[flows-cron] erro ao acordar o run:", run.id, message);
        await endRun(db, run, "active", "wake_exception", `Falha ao preparar a retomada do run: ${message}`, now);
      }
    }
    if (rows.length < batch) break;
  }
  return summary;
}

/** Acorda os runs `delayed` vencidos. Nunca lança por causa de um run. */
export async function wakeDelayedRuns(db: Db, options: WakeOptions = {}): Promise<WakeSummary> {
  const now = options.now ?? new Date();
  if (options.v2 ?? flowsCronV2Enabled()) {
    const result = await wakeV2(db, now, options);
    if (result !== "missing") return result;
    console.warn("[flows-cron] FLOWS_CRON_V2 ligada, mas a migration 210 não está aplicada — usando o caminho padrão.");
  }
  return wakeLegacy(db, now);
}
