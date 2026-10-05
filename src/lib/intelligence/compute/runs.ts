// Classificação de cada execução de fluxo a partir de flow_runs +
// flow_run_events (puro). Base de todas as métricas de IA/fluxo/ferramenta.
// Regras em metrics/registry.ts; event_type e payload conforme
// src/lib/flows/engine.ts (logEvent / logRunEvent).

import type { FlowEventRow, FlowRunRow } from "../types";

export const TAKEOVER_REASON = "ai_agent_takeover";
// paused_by_agent NÃO entra aqui de propósito: o atendente assumiu e a IA
// deixou de conter a conversa — conta como "agent_intervened" no retrato
// do momento, mesmo que a execução volte depois (PRD-04, catálogo).
const NOT_FINISHED = new Set(["active", "delayed"]);
const FAILED = new Set(["failed", "error"]);

/** Resultado final, um por execução (mutuamente exclusivos). */
export type RunOutcome = "in_progress" | "failed" | "human_handoff" | "agent_intervened" | "contained";

export interface RunFacts {
  run: FlowRunRow;
  /** Eventos da execução em ordem cronológica. */
  events: FlowEventRow[];
  isAi: boolean;
  finished: boolean;
  failed: boolean;
  /** Falha especificamente do nó de IA (end_reason/payload ai_agent_failed). */
  aiAgentFailed: boolean;
  humanHandoff: boolean;
  /** Evento 'handoff' humano (o último), se gravado. */
  handoffEvent: FlowEventRow | null;
  fallbackCount: number;
  outcome: RunOutcome;
}

function payloadOf(e: FlowEventRow): Record<string, unknown> {
  return e.payload ?? {};
}

export function isAiEvent(e: FlowEventRow): boolean {
  if (e.event_type === "tool_called" || e.event_type === "tool_result") return true;
  if (e.node_type === "ai_agent") return true;
  return payloadOf(e).node_type === "ai_agent";
}

export function isHumanHandoffEvent(e: FlowEventRow): boolean {
  return e.event_type === "handoff" && payloadOf(e).reason !== TAKEOVER_REASON;
}

function byTime(a: FlowEventRow, b: FlowEventRow): number {
  const d = Date.parse(a.created_at) - Date.parse(b.created_at);
  return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function classifyRun(run: FlowRunRow, rawEvents: FlowEventRow[]): RunFacts {
  const events = [...rawEvents].sort(byTime);
  const finished = !NOT_FINISHED.has(run.status);
  const failed = FAILED.has(run.status);
  const handoffEvents = events.filter(isHumanHandoffEvent);
  const humanHandoff =
    handoffEvents.length > 0 || (run.status === "handed_off" && run.end_reason !== TAKEOVER_REASON);
  const aiAgentFailed =
    failed &&
    (run.end_reason === "ai_agent_failed" ||
      events.some(
        (e) =>
          e.event_type === "ai_agent_failed" ||
          (e.event_type === "error" && payloadOf(e).reason === "ai_agent_failed"),
      ));

  let outcome: RunOutcome;
  if (!finished) outcome = "in_progress";
  else if (failed) outcome = "failed";
  else if (humanHandoff) outcome = "human_handoff";
  else if (run.status === "paused_by_agent") outcome = "agent_intervened";
  else outcome = "contained";

  return {
    run,
    events,
    isAi: events.some(isAiEvent),
    finished,
    failed,
    aiAgentFailed,
    humanHandoff,
    handoffEvent: handoffEvents.length > 0 ? handoffEvents[handoffEvents.length - 1] : null,
    fallbackCount: events.filter((e) => e.event_type === "fallback_fired").length,
    outcome,
  };
}

export function classifyRuns(runs: FlowRunRow[], events: FlowEventRow[]): RunFacts[] {
  const byRun = new Map<string, FlowEventRow[]>();
  for (const e of events) {
    const list = byRun.get(e.flow_run_id);
    if (list) list.push(e);
    else byRun.set(e.flow_run_id, [e]);
  }
  return runs.map((r) => classifyRun(r, byRun.get(r.id) ?? []));
}

/**
 * Nó onde a execução "parou": último evento de erro/handoff com node_key;
 * senão o current_node_key gravado na execução.
 */
export function stoppedAtNode(f: RunFacts): string | null {
  const interesting = new Set(["handoff", "error", "node_error", "ai_agent_failed", "timeout", "fallback_fired"]);
  for (let i = f.events.length - 1; i >= 0; i--) {
    const e = f.events[i];
    if (interesting.has(e.event_type) && e.node_key) return e.node_key;
  }
  return f.run.current_node_key;
}
