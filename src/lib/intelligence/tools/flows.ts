// get_flow_performance.

import { computeFlowCompletionRate } from "../compute/ai";
import { computeFlowPerformance } from "../compute/flows";
import { loadFlowNames } from "../data";
import { resolvePeriod, type PeriodInput } from "../period";
import { count } from "../stats";
import { loadFacts, notes, periodHeader, schemaWithPeriod, UUID_SCHEMA } from "./shared";
import { defineTool } from "./types";
import { asObject, optUuid, periodField } from "./validate";

export const getFlowPerformance = defineTool({
  name: "get_flow_performance",
  description:
    "Desempenho por fluxo (com ou sem IA): execuções iniciadas no período, encerradas, em andamento, concluídas, transferidas para humano, tempo esgotado, falhas, taxas de conclusão/transferência/falha (sobre as encerradas) e os nós onde mais execuções pararam mal (falha, transferência ou tempo esgotado).",
  inputSchema: schemaWithPeriod("Período e filtro opcional por fluxo.", {
    flow_id: { ...UUID_SCHEMA, description: "Opcional: só este fluxo." },
  }),
  validate(input: unknown): { period: PeriodInput; flow_id?: string } {
    const obj = asObject(input, ["period", "flow_id"]);
    return { period: periodField(obj), flow_id: optUuid(obj, "flow_id") };
  },
  async run(scope, input, ctx) {
    const period = resolvePeriod(input.period, ctx.nowMs);
    const { facts, truncated } = await loadFacts(scope, period, ctx, { flowId: input.flow_id });
    const names = await loadFlowNames(ctx.db, scope, facts.map((f) => f.run.flow_id));
    return {
      period: periodHeader(period),
      runs: count(facts.length),
      flow_completion_rate: computeFlowCompletionRate(facts),
      flows: computeFlowPerformance(facts, names),
      truncated,
      notes: notes(truncated),
    };
  },
});
