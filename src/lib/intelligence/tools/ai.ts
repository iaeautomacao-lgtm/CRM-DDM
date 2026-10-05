// get_ai_performance, get_ai_handoff_analysis, get_tool_performance.

import { computeAiMetrics, computeFallbackRate, computeHandoffAnalysis } from "../compute/ai";
import { computeFlowPerformance } from "../compute/flows";
import { computeToolPerformance } from "../compute/tools";
import { loadFlowNames } from "../data";
import { resolvePeriod, type PeriodInput } from "../period";
import { count } from "../stats";
import { loadFacts, notes, periodHeader, schemaWithPeriod, UUID_SCHEMA } from "./shared";
import { defineTool } from "./types";
import { asObject, optUuid, periodField } from "./validate";

interface AiInput {
  period: PeriodInput;
  flow_id?: string;
}

function validateAiInput(input: unknown): AiInput {
  const obj = asObject(input, ["period", "flow_id"]);
  return { period: periodField(obj), flow_id: optUuid(obj, "flow_id") };
}

const AI_SCHEMA_EXTRA = {
  flow_id: { ...UUID_SCHEMA, description: "Opcional: restringe a um fluxo." },
};

const OUTCOME_NOTE =
  "Cada execução de IA encerrada cai em exatamente um resultado: failed (status failed/error) > human_handoff (transferida para humano) > agent_intervened (paused_by_agent) > contained (o resto, inclusive timed_out e ai_agent_takeover). As taxas somam 1.";

export const getAiPerformance = defineTool({
  name: "get_ai_performance",
  description:
    "Desempenho do agente de IA nos fluxos: execuções com IA, taxa de transferência para humano, contenção (resolvido sem humano), falha, fallback, resumo das ferramentas e quebra por fluxo. Denominador das taxas = execuções de IA iniciadas no período e já encerradas.",
  inputSchema: schemaWithPeriod("Período e filtro opcional por fluxo.", AI_SCHEMA_EXTRA),
  validate: validateAiInput,
  async run(scope, input, ctx) {
    const period = resolvePeriod(input.period, ctx.nowMs);
    const { facts, truncated } = await loadFacts(scope, period, ctx, { flowId: input.flow_id });
    const aiFacts = facts.filter((f) => f.isAi);
    const names = await loadFlowNames(ctx.db, scope, aiFacts.map((f) => f.run.flow_id));
    const ai = computeAiMetrics(facts);
    const tools = computeToolPerformance(aiFacts);
    const byFlow = computeFlowPerformance(aiFacts, names).map((f) => {
      const m = computeAiMetrics(aiFacts.filter((x) => x.run.flow_id === f.flow_id));
      return {
        flow_id: f.flow_id,
        flow_name: f.flow_name,
        ai_runs: m.ai_runs,
        ai_runs_finished: m.ai_runs_finished,
        ai_handoff_rate: m.ai_handoff_rate,
        ai_containment_rate: m.ai_containment_rate,
        ai_failure_rate: m.ai_failure_rate,
      };
    });
    return {
      period: periodHeader(period),
      ...ai,
      ai_runs_in_progress: count(aiFacts.filter((f) => !f.finished).length),
      fallback_rate_ai_runs: computeFallbackRate(aiFacts),
      tools: tools.totals,
      by_flow: byFlow,
      truncated,
      notes: notes(truncated, [OUTCOME_NOTE]),
    };
  },
});

export const getAiHandoffAnalysis = defineTool({
  name: "get_ai_handoff_analysis",
  description:
    "Onde e por que a IA transfere para humano: transferências por fluxo (com taxa), por nó, pela última ferramenta chamada antes da transferência, por motivo (reason/end_reason: handoff_node, fallback_exhausted, ...) e por dia (horário de Brasília). Só execuções de IA encerradas; takeover da IA não conta como transferência.",
  inputSchema: schemaWithPeriod("Período e filtro opcional por fluxo.", AI_SCHEMA_EXTRA),
  validate: validateAiInput,
  async run(scope, input, ctx) {
    const period = resolvePeriod(input.period, ctx.nowMs);
    const { facts, truncated } = await loadFacts(scope, period, ctx, { flowId: input.flow_id });
    const names = await loadFlowNames(
      ctx.db,
      scope,
      facts.filter((f) => f.isAi).map((f) => f.run.flow_id),
    );
    return {
      period: periodHeader(period),
      ...computeHandoffAnalysis(facts, names),
      truncated,
      notes: notes(truncated),
    };
  },
});

export const getToolPerformance = defineTool({
  name: "get_tool_performance",
  description:
    "Desempenho de cada ferramenta (API) chamada pelo agente de IA: chamadas, resultados, sucessos, erros, taxa de sucesso, duração média/p50/p95 (ms) e quantas chamadas foram seguidas de transferência para humano na mesma execução. Erro = status 'error' ou corpo JSON com campo 'error'; HTTP 4xx/5xx sem esse campo conta como sucesso (o status HTTP não é gravado).",
  inputSchema: schemaWithPeriod("Período e filtro opcional por fluxo.", AI_SCHEMA_EXTRA),
  validate: validateAiInput,
  async run(scope, input, ctx) {
    const period = resolvePeriod(input.period, ctx.nowMs);
    const { facts, truncated } = await loadFacts(scope, period, ctx, { flowId: input.flow_id });
    return {
      period: periodHeader(period),
      ...computeToolPerformance(facts),
      truncated,
      notes: notes(truncated),
    };
  },
});
