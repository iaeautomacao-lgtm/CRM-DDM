// Registro das 10 ferramentas do MVP do DDM Intelligence (PRD-04).

import { supabaseAdmin } from "@/lib/flows/admin-client";
import type { IntelligenceScope } from "../scope";
import { getAgentPerformance } from "./agents";
import { getAiHandoffAnalysis, getAiPerformance, getToolPerformance } from "./ai";
import { getConversationTimeline, searchConversations } from "./conversations";
import { getFlowPerformance } from "./flows";
import { compareInstitutions } from "./institutions";
import { comparePeriods, getOverviewMetrics } from "./overview";
import type { RegisteredTool, ToolRunContext } from "./types";

export const INTELLIGENCE_TOOLS: readonly RegisteredTool[] = [
  getOverviewMetrics,
  comparePeriods,
  getAiPerformance,
  getAiHandoffAnalysis,
  getToolPerformance,
  getFlowPerformance,
  getAgentPerformance,
  compareInstitutions,
  searchConversations,
  getConversationTimeline,
];

export function getTool(name: string): RegisteredTool | undefined {
  return INTELLIGENCE_TOOLS.find((t) => t.name === name);
}

export function listTools(): Array<Pick<RegisteredTool, "name" | "description" | "inputSchema">> {
  return INTELLIGENCE_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** Valida e executa. O escopo vem do servidor, nunca do input. */
export async function executeTool(
  tool: RegisteredTool,
  scope: IntelligenceScope,
  rawInput: unknown,
  ctx: Partial<ToolRunContext> = {},
): Promise<unknown> {
  const input = tool.validate(rawInput);
  return tool.run(scope, input, { db: ctx.db ?? supabaseAdmin(), nowMs: ctx.nowMs ?? Date.now() });
}
