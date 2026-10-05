// Métricas de IA e de fluxo (puro), a partir de RunFacts (compute/runs.ts).

import { brazilDay } from "../period";
import { count, ratio, type Stat } from "../stats";
import { type RunFacts, stoppedAtNode } from "./runs";

export interface AiMetrics {
  ai_runs: Stat;
  ai_runs_finished: Stat;
  ai_handoff_rate: Stat;
  ai_failure_rate: Stat;
  ai_containment_rate: Stat;
  ai_agent_intervened_rate: Stat;
  /** Falhas com motivo ai_agent_failed (subconjunto de ai_failure_rate). */
  ai_agent_failed: Stat;
}

export function computeAiMetrics(facts: RunFacts[]): AiMetrics {
  const ai = facts.filter((f) => f.isAi);
  const finished = ai.filter((f) => f.finished);
  const n = finished.length;
  const by = (o: RunFacts["outcome"]) => finished.filter((f) => f.outcome === o).length;
  return {
    ai_runs: count(ai.length),
    ai_runs_finished: count(n),
    ai_handoff_rate: ratio(by("human_handoff"), n),
    ai_failure_rate: ratio(by("failed"), n),
    ai_containment_rate: ratio(by("contained"), n),
    ai_agent_intervened_rate: ratio(by("agent_intervened"), n),
    ai_agent_failed: count(finished.filter((f) => f.aiAgentFailed).length),
  };
}

export function computeFallbackRate(facts: RunFacts[]): Stat {
  return ratio(facts.filter((f) => f.fallbackCount > 0).length, facts.length);
}

export function computeFlowCompletionRate(facts: RunFacts[]): Stat {
  const finished = facts.filter((f) => f.finished);
  return ratio(finished.filter((f) => f.run.status === "completed").length, finished.length);
}

// ------------------------------------------------------------
// Análise de transferências da IA
// ------------------------------------------------------------

export interface Bucket {
  key: string;
  label: string;
  handoffs: Stat;
  /** Participação no total de transferências. */
  share: Stat;
}

export interface HandoffAnalysis {
  ai_runs_finished: Stat;
  handoffs: Stat;
  ai_handoff_rate: Stat;
  by_flow: Array<Bucket & { ai_runs_finished: Stat; handoff_rate: Stat }>;
  by_node: Bucket[];
  by_preceding_tool: Bucket[];
  by_reason: Bucket[];
  by_day: Array<{ day: string; handoffs: Stat; ai_runs_finished: Stat; handoff_rate: Stat }>;
}

export const NO_TOOL = "(nenhuma)";

/** Última ferramenta chamada antes da transferência, na mesma execução. */
export function precedingTool(f: RunFacts): string {
  const limit = f.handoffEvent ? Date.parse(f.handoffEvent.created_at) : Number.POSITIVE_INFINITY;
  let name: string | null = null;
  for (const e of f.events) {
    if (Date.parse(e.created_at) > limit) break;
    if (e.event_type === "tool_called" || e.event_type === "tool_result") {
      const t = (e.payload ?? {}).tool_name;
      if (typeof t === "string" && t) name = t;
    }
  }
  return name ?? NO_TOOL;
}

export function handoffReason(f: RunFacts): string {
  const r = f.handoffEvent ? (f.handoffEvent.payload ?? {}).reason : undefined;
  if (typeof r === "string" && r) return r;
  return f.run.end_reason ?? "sem_motivo";
}

function handoffDay(f: RunFacts): string {
  return brazilDay(f.handoffEvent?.created_at ?? f.run.ended_at ?? f.run.started_at);
}

function buckets(items: RunFacts[], keyOf: (f: RunFacts) => string, labelOf: (k: string) => string): Bucket[] {
  const map = new Map<string, number>();
  for (const f of items) map.set(keyOf(f), (map.get(keyOf(f)) ?? 0) + 1);
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, n]) => ({ key, label: labelOf(key), handoffs: count(n), share: ratio(n, items.length) }));
}

export function computeHandoffAnalysis(
  facts: RunFacts[],
  flowNames: Map<string, string> = new Map(),
): HandoffAnalysis {
  const finished = facts.filter((f) => f.isAi && f.finished);
  const handed = finished.filter((f) => f.outcome === "human_handoff");
  const flowLabel = (k: string) => flowNames.get(k) ?? k;

  const byFlow = buckets(handed, (f) => f.run.flow_id, flowLabel).map((b) => {
    const den = finished.filter((f) => f.run.flow_id === b.key).length;
    return { ...b, ai_runs_finished: count(den), handoff_rate: ratio(b.handoffs.numerator, den) };
  });
  // Fluxos com IA sem nenhuma transferência também aparecem (taxa 0).
  for (const flowId of new Set(finished.map((f) => f.run.flow_id))) {
    if (byFlow.some((b) => b.key === flowId)) continue;
    const den = finished.filter((f) => f.run.flow_id === flowId).length;
    byFlow.push({
      key: flowId,
      label: flowLabel(flowId),
      handoffs: count(0),
      share: ratio(0, handed.length),
      ai_runs_finished: count(den),
      handoff_rate: ratio(0, den),
    });
  }

  const days = new Map<string, { h: number; n: number }>();
  for (const f of finished) {
    const d = handoffDay(f);
    const cur = days.get(d) ?? { h: 0, n: 0 };
    cur.n += 1;
    if (f.outcome === "human_handoff") cur.h += 1;
    days.set(d, cur);
  }

  return {
    ai_runs_finished: count(finished.length),
    handoffs: count(handed.length),
    ai_handoff_rate: ratio(handed.length, finished.length),
    by_flow: byFlow,
    by_node: buckets(handed, (f) => f.handoffEvent?.node_key ?? stoppedAtNode(f) ?? "(desconhecido)", (k) => k),
    by_preceding_tool: buckets(handed, precedingTool, (k) => k),
    by_reason: buckets(handed, handoffReason, (k) => k),
    by_day: [...days.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, v]) => ({ day, handoffs: count(v.h), ai_runs_finished: count(v.n), handoff_rate: ratio(v.h, v.n) })),
  };
}
