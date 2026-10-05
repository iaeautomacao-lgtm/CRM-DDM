import { describe, expect, it } from "vitest";
import { EVENTS, RUNS } from "../__tests__/fixtures";
import { resolvePeriod } from "../period";
import type { ConversationRow } from "../types";
import { computeAgentPerformance } from "./agents";
import { computeAiMetrics, computeFallbackRate, computeFlowCompletionRate, computeHandoffAnalysis } from "./ai";
import { computeConversationMetrics } from "./conversations";
import { computeFlowPerformance } from "./flows";
import { computeInstitutions } from "./institutions";
import { classifyRuns } from "./runs";
import { computeToolPerformance, isToolResultError } from "./tools";

const facts = classifyRuns(RUNS, EVENTS);
const outcome = (id: string) => facts.find((f) => f.run.id === id)!.outcome;

describe("classifyRuns", () => {
  it("um resultado por execução", () => {
    expect(RUNS.map((r) => outcome(r.id))).toEqual([
      "human_handoff", // r1
      "contained", // r2
      "failed", // r3
      "contained", // r4 takeover da IA não é humano
      "in_progress", // r5
      "contained", // r6
      "agent_intervened", // r7
      "human_handoff", // r8 status handed_off sem evento
    ]);
    expect(facts.filter((f) => f.isAi).map((f) => f.run.id)).toEqual(["r1", "r2", "r3", "r4", "r5", "r7"]);
    expect(facts.find((f) => f.run.id === "r3")!.aiAgentFailed).toBe(true);
  });
});

describe("computeAiMetrics", () => {
  it("taxas sobre as 5 execuções de IA encerradas (r1 r2 r3 r4 r7); somam 1", () => {
    const m = computeAiMetrics(facts);
    expect(m.ai_runs).toEqual({ value: 6, numerator: 6, denominator: 1 });
    expect(m.ai_runs_finished.value).toBe(5);
    expect(m.ai_handoff_rate).toEqual({ value: 0.2, numerator: 1, denominator: 5 });
    expect(m.ai_failure_rate).toEqual({ value: 0.2, numerator: 1, denominator: 5 });
    expect(m.ai_containment_rate).toEqual({ value: 0.4, numerator: 2, denominator: 5 });
    expect(m.ai_agent_intervened_rate).toEqual({ value: 0.2, numerator: 1, denominator: 5 });
    expect(m.ai_agent_failed.value).toBe(1);
  });

  it("sem execuções: value null (nunca 0 inventado)", () => {
    const m = computeAiMetrics([]);
    expect(m.ai_handoff_rate).toEqual({ value: null, numerator: 0, denominator: 0 });
  });

  it("fallback (r1, r6 de 8) e conclusão (r2, r6 de 7 encerradas)", () => {
    expect(computeFallbackRate(facts)).toEqual({ value: 0.25, numerator: 2, denominator: 8 });
    expect(computeFlowCompletionRate(facts)).toEqual({ value: 0.2857, numerator: 2, denominator: 7 });
  });
});

describe("computeHandoffAnalysis", () => {
  const names = new Map([["F1", "Cobrança"]]);
  const a = computeHandoffAnalysis(facts, names);

  it("só transferência humana de IA: r1", () => {
    expect(a.handoffs.value).toBe(1);
    expect(a.ai_handoff_rate).toEqual({ value: 0.2, numerator: 1, denominator: 5 });
  });

  it("por fluxo com taxa (F1: 1 de 3; F2: 0 de 2)", () => {
    const f1 = a.by_flow.find((b) => b.key === "F1")!;
    expect(f1.label).toBe("Cobrança");
    expect(f1.handoff_rate).toEqual({ value: 0.3333, numerator: 1, denominator: 3 });
    const f2 = a.by_flow.find((b) => b.key === "F2")!;
    expect(f2.handoff_rate).toEqual({ value: 0, numerator: 0, denominator: 2 });
  });

  it("por nó, ferramenta anterior, motivo e dia", () => {
    expect(a.by_node.map((b) => [b.key, b.handoffs.value])).toEqual([["n_menu", 1]]);
    expect(a.by_preceding_tool.map((b) => b.key)).toEqual(["consulta"]);
    expect(a.by_reason.map((b) => b.key)).toEqual(["fallback_exhausted"]);
    expect(a.by_reason[0].share).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(a.by_day).toEqual([
      {
        day: "2026-10-02",
        handoffs: { value: 1, numerator: 1, denominator: 1 },
        ai_runs_finished: { value: 5, numerator: 5, denominator: 1 },
        handoff_rate: { value: 0.2, numerator: 1, denominator: 5 },
      },
    ]);
  });
});

describe("computeToolPerformance", () => {
  const t = computeToolPerformance(facts);

  it("totais: 4 resultados, 2 com erro; latência p50/p95 de [50,100,300,1000]", () => {
    expect(t.totals.calls.value).toBe(4);
    expect(t.totals.tool_success_rate).toEqual({ value: 0.5, numerator: 2, denominator: 4 });
    expect(t.totals.tool_latency_p50_ms).toEqual({ value: 100, numerator: 2, denominator: 4 });
    expect(t.totals.tool_latency_p95_ms).toEqual({ value: 1000, numerator: 4, denominator: 4 });
  });

  it("por ferramenta, com transferência depois da chamada", () => {
    const consulta = t.tools.find((x) => x.tool_name === "consulta")!;
    expect(consulta.errors.value).toBe(1);
    expect(consulta.success_rate).toEqual({ value: 0.5, numerator: 1, denominator: 2 });
    expect(consulta.duration_avg_ms).toEqual({ value: 200, numerator: 400, denominator: 2 });
    expect(consulta.handoff_after_call).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(consulta.handoff_after_call_rate).toEqual({ value: 0.5, numerator: 1, denominator: 2 });
    const boleto = t.tools.find((x) => x.tool_name === "boleto")!;
    expect(boleto.errors.value).toBe(1);
    expect(boleto.duration_avg_ms.value).toBe(525);
    expect(boleto.duration_p95_ms.value).toBe(1000);
    expect(boleto.handoff_after_call.value).toBe(0); // r4 é takeover
  });

  it("detecção de erro no resultado", () => {
    const base = EVENTS.find((e) => e.event_type === "tool_result")!;
    const withResult = (result: unknown, status: "success" | "error" = "success") => ({
      ...base,
      status,
      payload: { tool_name: "x", result },
    });
    expect(isToolResultError(withResult('{"error":"x"}'))).toBe(true);
    expect(isToolResultError(withResult('{"error": "cortado…'))).toBe(true);
    expect(isToolResultError(withResult('{"error":null,"ok":1}'))).toBe(false);
    expect(isToolResultError(withResult("[1,2]"))).toBe(false);
    expect(isToolResultError(withResult("texto"))).toBe(false);
    expect(isToolResultError(withResult('{"ok":1}', "error"))).toBe(true);
  });
});

describe("computeFlowPerformance", () => {
  const flows = computeFlowPerformance(facts, new Map([["F2", "Receptivo"]]));

  it("F2: 5 execuções, 4 encerradas, 1 concluída, 1 transferida (r8); nó problemático h1", () => {
    const f2 = flows.find((f) => f.flow_id === "F2")!;
    expect(f2.flow_name).toBe("Receptivo");
    expect(f2.runs.value).toBe(5);
    expect(f2.in_progress.value).toBe(1);
    expect(f2.completion_rate).toEqual({ value: 0.25, numerator: 1, denominator: 4 });
    expect(f2.handed_off.value).toBe(1);
    expect(f2.top_problem_nodes.map((n) => n.node_key)).toEqual(["h1"]);
  });

  it("F1: conclusão 1/3, falha 1/3, nós ia e n_menu", () => {
    const f1 = flows.find((f) => f.flow_id === "F1")!;
    expect(f1.completion_rate).toEqual({ value: 0.3333, numerator: 1, denominator: 3 });
    expect(f1.failure_rate).toEqual({ value: 0.3333, numerator: 1, denominator: 3 });
    expect(f1.top_problem_nodes.map((n) => [n.node_key, n.runs.value])).toEqual([
      ["ia", 1],
      ["n_menu", 1],
    ]);
  });
});

// ------------------------------------------------------------
// Conversas
// ------------------------------------------------------------

const PERIOD = resolvePeriod({ date_from: "2026-10-01", date_to: "2026-10-07" }); // [10-01T03:00Z, 10-08T03:00Z)
const conv = (over: Partial<ConversationRow>): ConversationRow => ({
  id: "c",
  status: "open",
  channel_type: "whatsapp",
  team_id: null,
  client_id: null,
  assigned_agent_id: null,
  created_at: "2026-10-02T12:00:00.000Z",
  first_response_at: null,
  closed_at: null,
  ...over,
});
const plusMin = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();

describe("computeConversationMetrics", () => {
  const rows = [
    conv({ id: "c1", status: "open" }),
    conv({ id: "c2", status: "pending", first_response_at: plusMin("2026-10-02T12:00:00.000Z", 10) }),
    conv({
      id: "c3",
      status: "closed",
      first_response_at: plusMin("2026-10-02T12:00:00.000Z", 20),
      closed_at: "2026-10-03T12:00:00.000Z",
    }),
    // Criada antes do período (29/09 23:50 em Brasília), atendida e fechada nele: 1470 min.
    conv({
      id: "c4",
      status: "closed",
      created_at: "2026-09-30T02:50:00.000Z",
      first_response_at: "2026-10-01T03:20:00.000Z",
      closed_at: "2026-10-01T04:00:00.000Z",
    }),
    // Exatamente no fim exclusivo: fora.
    conv({ id: "c5", created_at: "2026-10-08T03:00:00.000Z" }),
  ];
  const m = computeConversationMetrics(rows, PERIOD);

  it("recebidas por created_at, finalizadas por closed_at", () => {
    expect(m.conversations_total.value).toBe(3);
    expect(m.conversations_open.value).toBe(1);
    expect(m.conversations_pending.value).toBe(1);
    expect(m.conversations_closed.value).toBe(2);
  });

  it("1ª resposta das atendidas no período: (10 + 20 + 1470) / 3", () => {
    expect(m.first_response_avg_min).toEqual({ value: 500, numerator: 1500, denominator: 3 });
    expect(m.first_response_p90_min).toEqual({ value: 1470, numerator: 3, denominator: 3 });
  });
});

describe("computeAgentPerformance", () => {
  const rows = [
    conv({ id: "c1", assigned_agent_id: "a1" }),
    conv({
      id: "c2",
      assigned_agent_id: "a1",
      status: "closed",
      first_response_at: plusMin("2026-10-02T12:00:00.000Z", 10),
      closed_at: "2026-10-02T13:00:00.000Z",
    }),
    conv({ id: "c3", assigned_agent_id: null }),
  ];
  const openNow = [
    { assigned_agent_id: "a1", status: "open" as const },
    { assigned_agent_id: "a3", status: "pending" as const },
  ];
  const agents = computeAgentPerformance(rows, openNow, PERIOD, new Map([["a1", "Ana"]]));

  it("conversas, finalizadas, abertas agora e 1ª resposta por atendente", () => {
    const a1 = agents.find((a) => a.agent_id === "a1")!;
    expect(a1.agent_name).toBe("Ana");
    expect(a1.conversations.value).toBe(2);
    expect(a1.closed.value).toBe(1);
    expect(a1.open_now.value).toBe(1);
    expect(a1.first_response_avg_min).toEqual({ value: 10, numerator: 10, denominator: 1 });
    const a3 = agents.find((a) => a.agent_id === "a3")!;
    expect(a3.conversations.value).toBe(0);
    expect(a3.open_now.value).toBe(1);
    expect(a3.first_response_avg_min.value).toBeNull();
    expect(agents.find((a) => a.agent_id === "none")!.agent_name).toBe("Sem atendente");
  });
});

describe("computeInstitutions", () => {
  const rows = [
    conv({ id: "c-r1", client_id: "X" }),
    conv({ id: "c-r2", client_id: "X", status: "closed", closed_at: "2026-10-03T00:00:00.000Z" }),
    conv({ id: "c-r3", client_id: null }),
  ];
  // Execuções r1..r8 (fixtures) → conversas c-r1..c-r8; r1/r2 do cliente X.
  const runClient = new Map<string, string | null>([
    ["c-r1", "X"],
    ["c-r2", "X"],
    ["c-r3", null],
    ["c-r4", null],
    ["c-r7", null],
  ]);
  const inst = computeInstitutions(rows, facts, runClient, PERIOD, new Map([["X", "Banco X"]]));

  it("bucket Sem cliente e métricas por instituição", () => {
    const x = inst.find((i) => i.client_id === "X")!;
    expect(x.client_name).toBe("Banco X");
    expect(x.conversations_total.value).toBe(2);
    expect(x.conversations_closed.value).toBe(1);
    expect(x.conversations_open_or_pending.value).toBe(1);
    // r1 (handoff) e r2 (contida)
    expect(x.ai_handoff_rate).toEqual({ value: 0.5, numerator: 1, denominator: 2 });
    expect(x.ai_containment_rate).toEqual({ value: 0.5, numerator: 1, denominator: 2 });
    const none = inst.find((i) => i.client_id === "none")!;
    expect(none.client_name).toBe("Sem cliente");
    // r3 (falha), r4 (contida), r7 (pausada)
    expect(none.ai_runs_finished.value).toBe(3);
    expect(none.ai_handoff_rate).toEqual({ value: 0, numerator: 0, denominator: 3 });
  });
});
