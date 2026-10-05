// Desempenho por fluxo (puro).

import { count, ratio, type Stat } from "../stats";
import { type RunFacts, stoppedAtNode } from "./runs";

export interface FlowStats {
  flow_id: string;
  flow_name: string;
  runs: Stat;
  finished: Stat;
  in_progress: Stat;
  completed: Stat;
  handed_off: Stat;
  timed_out: Stat;
  failed: Stat;
  ai_runs: Stat;
  completion_rate: Stat;
  handoff_rate: Stat;
  failure_rate: Stat;
  /** Nós onde mais execuções pararam mal (falha, transferência humana, tempo esgotado). */
  top_problem_nodes: Array<{ node_key: string; runs: Stat; share: Stat }>;
}

const TOP_NODES = 5;

function isProblem(f: RunFacts): boolean {
  return f.outcome === "failed" || f.outcome === "human_handoff" || f.run.status === "timed_out";
}

export function computeFlowPerformance(facts: RunFacts[], flowNames: Map<string, string> = new Map()): FlowStats[] {
  const byFlow = new Map<string, RunFacts[]>();
  for (const f of facts) {
    const list = byFlow.get(f.run.flow_id);
    if (list) list.push(f);
    else byFlow.set(f.run.flow_id, [f]);
  }
  return [...byFlow.entries()]
    .map(([flowId, list]) => {
      const finished = list.filter((f) => f.finished);
      const n = finished.length;
      const completed = finished.filter((f) => f.run.status === "completed").length;
      const handed = finished.filter((f) => f.outcome === "human_handoff").length;
      const failed = finished.filter((f) => f.outcome === "failed").length;
      const problems = finished.filter(isProblem);
      const nodes = new Map<string, number>();
      for (const f of problems) {
        const k = stoppedAtNode(f) ?? "(desconhecido)";
        nodes.set(k, (nodes.get(k) ?? 0) + 1);
      }
      return {
        flow_id: flowId,
        flow_name: flowNames.get(flowId) ?? flowId,
        runs: count(list.length),
        finished: count(n),
        in_progress: count(list.length - n),
        completed: count(completed),
        handed_off: count(handed),
        timed_out: count(finished.filter((f) => f.run.status === "timed_out").length),
        failed: count(failed),
        ai_runs: count(list.filter((f) => f.isAi).length),
        completion_rate: ratio(completed, n),
        handoff_rate: ratio(handed, n),
        failure_rate: ratio(failed, n),
        top_problem_nodes: [...nodes.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, TOP_NODES)
          .map(([node_key, c]) => ({ node_key, runs: count(c), share: ratio(c, problems.length) })),
      };
    })
    .sort((a, b) => (b.runs.value ?? 0) - (a.runs.value ?? 0) || a.flow_name.localeCompare(b.flow_name));
}
