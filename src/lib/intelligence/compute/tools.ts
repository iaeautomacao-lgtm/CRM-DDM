// Desempenho das ferramentas (tool calling) do agente de IA (puro).
//
// Eventos (engine.ts → logRunEvent, migration 067):
//   tool_called  payload.tool_name, payload.args — antes da chamada HTTP
//   tool_result  payload.tool_name, payload.result (truncado em 8000),
//                duration_ms — depois da chamada
// O motor grava tool_result com status 'success' até quando a chamada
// falha; a falha vem no corpo como {"error": "..."} (responder.ts). Por
// isso o erro é detectado também pelo conteúdo.

import { count, mean, percentile, ratio, type Stat } from "../stats";
import type { FlowEventRow } from "../types";
import type { RunFacts } from "./runs";

export function isToolResultError(e: FlowEventRow): boolean {
  if (e.status === "error") return true;
  const result = (e.payload ?? {}).result;
  if (typeof result !== "string") return false;
  const s = result.trim();
  if (!s.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(s) as unknown;
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).error !== undefined &&
      (parsed as Record<string, unknown>).error !== null &&
      (parsed as Record<string, unknown>).error !== false
    );
  } catch {
    // Truncado (… no fim) ou não-JSON: só o prefixo clássico do motor.
    return /^\{\s*"error"\s*:/.test(s);
  }
}

function toolName(e: FlowEventRow): string {
  const t = (e.payload ?? {}).tool_name;
  return typeof t === "string" && t ? t : "(sem nome)";
}

export interface ToolStats {
  tool_name: string;
  calls: Stat;
  results: Stat;
  success: Stat;
  errors: Stat;
  success_rate: Stat;
  duration_avg_ms: Stat;
  duration_p50_ms: Stat;
  duration_p95_ms: Stat;
  /** Resultados seguidos de transferência humana na mesma execução. */
  handoff_after_call: Stat;
  handoff_after_call_rate: Stat;
}

export interface ToolPerformance {
  totals: {
    calls: Stat;
    results: Stat;
    tool_success_rate: Stat;
    tool_latency_p50_ms: Stat;
    tool_latency_p95_ms: Stat;
  };
  tools: ToolStats[];
}

interface Acc {
  calls: number;
  results: number;
  errors: number;
  durations: number[];
  handoffAfter: number;
}

export function computeToolPerformance(facts: RunFacts[]): ToolPerformance {
  const acc = new Map<string, Acc>();
  const get = (name: string) => {
    let a = acc.get(name);
    if (!a) {
      a = { calls: 0, results: 0, errors: 0, durations: [], handoffAfter: 0 };
      acc.set(name, a);
    }
    return a;
  };
  let calls = 0;
  let results = 0;
  let errors = 0;
  const allDurations: number[] = [];

  for (const f of facts) {
    const handoffAt =
      f.outcome === "human_handoff"
        ? f.handoffEvent
          ? Date.parse(f.handoffEvent.created_at)
          : Number.POSITIVE_INFINITY
        : null;
    for (const e of f.events) {
      if (e.event_type === "tool_called") {
        get(toolName(e)).calls += 1;
        calls += 1;
      } else if (e.event_type === "tool_result") {
        const a = get(toolName(e));
        a.results += 1;
        results += 1;
        if (isToolResultError(e)) {
          a.errors += 1;
          errors += 1;
        }
        if (typeof e.duration_ms === "number") {
          a.durations.push(e.duration_ms);
          allDurations.push(e.duration_ms);
        }
        if (handoffAt !== null && Date.parse(e.created_at) <= handoffAt) a.handoffAfter += 1;
      }
    }
  }

  const tools: ToolStats[] = [...acc.entries()]
    .map(([name, a]) => ({
      tool_name: name,
      calls: count(a.calls),
      results: count(a.results),
      success: count(a.results - a.errors),
      errors: count(a.errors),
      success_rate: ratio(a.results - a.errors, a.results),
      duration_avg_ms: mean(a.durations, 0),
      duration_p50_ms: percentile(a.durations, 50, 0),
      duration_p95_ms: percentile(a.durations, 95, 0),
      handoff_after_call: count(a.handoffAfter),
      handoff_after_call_rate: ratio(a.handoffAfter, a.results),
    }))
    .sort((x, y) => (y.calls.value ?? 0) - (x.calls.value ?? 0) || x.tool_name.localeCompare(y.tool_name));

  return {
    totals: {
      calls: count(calls),
      results: count(results),
      tool_success_rate: ratio(results - errors, results),
      tool_latency_p50_ms: percentile(allDurations, 50, 0),
      tool_latency_p95_ms: percentile(allDurations, 95, 0),
    },
    tools,
  };
}
