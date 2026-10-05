// get_agent_performance.

import { computeAgentPerformance, NO_AGENT } from "../compute/agents";
import { loadAgentNames, loadOpenNowConversations, loadPeriodConversations } from "../data";
import { resolvePeriod, type PeriodInput } from "../period";
import { narrowScopeToTeam } from "../scope";
import { notes, periodHeader, schemaWithPeriod, UUID_SCHEMA } from "./shared";
import { defineTool } from "./types";
import { asObject, optUuid, periodField } from "./validate";

export const getAgentPerformance = defineTool({
  name: "get_agent_performance",
  description:
    "Desempenho por atendente humano: conversas criadas no período atribuídas a ele, finalizadas no período, abertas/pendentes agora e tempo médio de 1ª resposta (min). Usa a atribuição ATUAL da conversa. \"Sem atendente\" agrupa as conversas sem atribuição.",
  inputSchema: schemaWithPeriod("Período e filtros opcionais.", {
    agent_id: { ...UUID_SCHEMA, description: "Opcional: só este atendente (user_id)." },
    team_id: { ...UUID_SCHEMA, description: "Opcional: só esta equipe (precisa estar no seu escopo)." },
  }),
  validate(input: unknown): { period: PeriodInput; agent_id?: string; team_id?: string } {
    const obj = asObject(input, ["period", "agent_id", "team_id"]);
    return { period: periodField(obj), agent_id: optUuid(obj, "agent_id"), team_id: optUuid(obj, "team_id") };
  },
  async run(baseScope, input, ctx) {
    const scope = narrowScopeToTeam(baseScope, input.team_id);
    const period = resolvePeriod(input.period, ctx.nowMs);
    const [conv, openNow] = await Promise.all([
      loadPeriodConversations(ctx.db, scope, period),
      loadOpenNowConversations(ctx.db, scope),
    ]);
    const ids = [...conv.rows, ...openNow.rows]
      .map((r) => r.assigned_agent_id)
      .filter((id): id is string => !!id);
    const names = await loadAgentNames(ctx.db, scope, ids);
    let agents = computeAgentPerformance(conv.rows, openNow.rows, period, names);
    if (input.agent_id) agents = agents.filter((a) => a.agent_id === input.agent_id);
    const truncated = conv.truncated || openNow.truncated;
    return {
      period: periodHeader(period),
      agents,
      truncated,
      notes: notes(truncated, agents.some((a) => a.agent_id === NO_AGENT) ? ["agent_id \"none\" = conversas sem atendente."] : []),
    };
  },
});
