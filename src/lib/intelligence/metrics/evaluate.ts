// Calcula métricas escalares do catálogo para um escopo + período,
// carregando cada fonte uma vez só. Usado por get_overview_metrics e
// compare_periods.

import { computeAiMetrics, computeFallbackRate, computeFlowCompletionRate } from "../compute/ai";
import { computeConversationMetrics } from "../compute/conversations";
import { classifyRuns } from "../compute/runs";
import { computeToolPerformance } from "../compute/tools";
import { loadFlowRuns, loadPeriodConversations, loadRunEvents } from "../data";
import type { IntelligenceScope } from "../scope";
import type { Stat } from "../stats";
import type { ToolRunContext } from "../tools/types";
import type { Period } from "../types";
import { getMetric, SCALAR_METRIC_IDS } from "./registry";

export interface EvaluatedMetric extends Stat {
  id: string;
  display_name: string;
  unit: string;
  version: number;
}

export interface Evaluation {
  metrics: EvaluatedMetric[];
  /** true quando alguma fonte bateu no teto de linhas: números parciais. */
  truncated: boolean;
}

export async function evaluateScalarMetrics(
  ids: string[],
  scope: IntelligenceScope,
  period: Period,
  ctx: ToolRunContext,
): Promise<Evaluation> {
  const wanted = ids.filter((id) => SCALAR_METRIC_IDS.includes(id));
  const needsConversations = wanted.some((id) => getMetric(id)?.source.includes("conversations"));
  const needsRuns = wanted.some((id) => !getMetric(id)?.source.includes("conversations"));

  const values: Record<string, Stat> = {};
  let truncated = false;

  if (needsConversations) {
    const conv = await loadPeriodConversations(ctx.db, scope, period);
    truncated = truncated || conv.truncated;
    Object.assign(values, computeConversationMetrics(conv.rows, period));
  }
  if (needsRuns) {
    const runs = await loadFlowRuns(ctx.db, scope, period);
    const events = await loadRunEvents(
      ctx.db,
      runs.rows.map((r) => r.id),
    );
    truncated = truncated || runs.truncated || events.truncated;
    const facts = classifyRuns(runs.rows, events.rows);
    const ai = computeAiMetrics(facts);
    const tools = computeToolPerformance(facts);
    Object.assign(values, {
      ai_runs: ai.ai_runs,
      ai_handoff_rate: ai.ai_handoff_rate,
      ai_failure_rate: ai.ai_failure_rate,
      ai_containment_rate: ai.ai_containment_rate,
      fallback_rate: computeFallbackRate(facts),
      flow_completion_rate: computeFlowCompletionRate(facts),
      tool_success_rate: tools.totals.tool_success_rate,
      tool_latency_p50_ms: tools.totals.tool_latency_p50_ms,
      tool_latency_p95_ms: tools.totals.tool_latency_p95_ms,
    });
  }

  return {
    metrics: wanted.map((id) => {
      const def = getMetric(id)!;
      const v = values[id] ?? { value: null, numerator: 0, denominator: 0 };
      return { id, display_name: def.display_name, unit: def.unit, version: def.version, ...v };
    }),
    truncated,
  };
}
