// Dados sintéticos das execuções de fluxo usados nos testes de cálculo.
// Expectativas calculadas à mão nos próprios testes (comentários lá).
//
//   r1 F1 IA  handed_off   fallback + consulta(ok,100ms) + handoff(fallback_exhausted) em n_menu
//   r2 F1 IA  completed    consulta({"error"},300ms)
//   r3 F1 IA  failed       ai_agent_failed em "ia"; boleto(erro truncado,50ms)
//   r4 F2 IA  handed_off   ai_agent_takeover (não é humano); boleto(ok,1000ms)
//   r5 F2 IA  active       (em andamento)
//   r6 F2     completed    fallback (sem IA)
//   r7 F2 IA  paused_by_agent
//   r8 F2     handed_off   handoff_node sem evento gravado; current_node_key h1

import type { FlowEventRow, FlowRunRow } from "../types";

const T = (min: number) => new Date(Date.parse("2026-10-02T13:00:00Z") + min * 60_000).toISOString();

function run(id: string, flow_id: string, status: FlowRunRow["status"], extra: Partial<FlowRunRow> = {}): FlowRunRow {
  return {
    id,
    flow_id,
    conversation_id: `c-${id}`,
    status,
    current_node_key: null,
    started_at: T(0),
    ended_at: status === "active" ? null : T(30),
    end_reason: null,
    ...extra,
  };
}

let seq = 0;
function ev(flow_run_id: string, event_type: string, min: number, extra: Partial<FlowEventRow> = {}): FlowEventRow {
  seq += 1;
  return {
    id: `e${String(seq).padStart(3, "0")}`,
    flow_run_id,
    event_type,
    node_key: null,
    node_type: null,
    status: null,
    duration_ms: null,
    payload: {},
    created_at: T(min),
    ...extra,
  };
}

const aiEnter = (r: string, min: number) =>
  ev(r, "node_entered", min, { node_key: "ia", payload: { node_type: "ai_agent" } });
const called = (r: string, min: number, tool: string) =>
  ev(r, "tool_called", min, { node_key: "ia", node_type: "ai_agent", status: "success", payload: { tool_name: tool } });
const result = (r: string, min: number, tool: string, ms: number, body: string, status: "success" | "error" = "success") =>
  ev(r, "tool_result", min, {
    node_key: "ia",
    node_type: "ai_agent",
    status,
    duration_ms: ms,
    payload: { tool_name: tool, result: body },
  });

export const RUNS: FlowRunRow[] = [
  run("r1", "F1", "handed_off", { end_reason: "fallback_exhausted" }),
  run("r2", "F1", "completed", { end_reason: "end_node" }),
  run("r3", "F1", "failed", { end_reason: "ai_agent_failed" }),
  run("r4", "F2", "handed_off", { end_reason: "ai_agent_takeover" }),
  run("r5", "F2", "active"),
  run("r6", "F2", "completed", { end_reason: "end_node" }),
  run("r7", "F2", "paused_by_agent"),
  run("r8", "F2", "handed_off", { end_reason: "handoff_node", current_node_key: "h1" }),
];

export const EVENTS: FlowEventRow[] = [
  aiEnter("r1", 1),
  ev("r1", "fallback_fired", 2, { node_key: "n_menu", payload: { action: "reprompt" } }),
  called("r1", 3, "consulta"),
  result("r1", 4, "consulta", 100, '{"ok":true}'),
  ev("r1", "handoff", 5, { node_key: "n_menu", payload: { reason: "fallback_exhausted" } }),

  aiEnter("r2", 1),
  called("r2", 2, "consulta"),
  result("r2", 3, "consulta", 300, '{"error":"timeout"}'),

  aiEnter("r3", 1),
  called("r3", 2, "boleto"),
  result("r3", 3, "boleto", 50, '{"error":"falha ao gerar boleto e mais texto…'),
  ev("r3", "error", 4, { node_key: "ia", payload: { reason: "ai_agent_failed" } }),

  aiEnter("r4", 1),
  called("r4", 2, "boleto"),
  result("r4", 3, "boleto", 1000, '{"linha":"123"}'),
  ev("r4", "handoff", 4, { node_key: "ia", payload: { reason: "ai_agent_takeover" } }),

  aiEnter("r5", 1),

  ev("r6", "node_entered", 1, { node_key: "menu", payload: { node_type: "send_buttons" } }),
  ev("r6", "fallback_fired", 2, { node_key: "menu" }),

  aiEnter("r7", 1),
];
