// Peças comuns das ferramentas: carregar execuções classificadas e montar
// o cabeçalho padrão da resposta.

import { classifyRuns, type RunFacts } from "../compute/runs";
import { type ConversationMeta, loadFlowRuns, loadRunEvents } from "../data";
import type { IntelligenceScope } from "../scope";
import type { Period } from "../types";
import type { JsonSchemaObject, ToolRunContext } from "./types";
import { PERIOD_SCHEMA } from "../period";

export interface LoadedFacts {
  facts: RunFacts[];
  truncated: boolean;
  conversationMeta: Map<string, ConversationMeta> | null;
}

export async function loadFacts(
  scope: IntelligenceScope,
  period: Period,
  ctx: ToolRunContext,
  opts: { withConversationMeta?: boolean; flowId?: string } = {},
): Promise<LoadedFacts> {
  const runs = await loadFlowRuns(ctx.db, scope, period, opts);
  const events = await loadRunEvents(
    ctx.db,
    runs.rows.map((r) => r.id),
  );
  return {
    facts: classifyRuns(runs.rows, events.rows),
    truncated: runs.truncated || events.truncated,
    conversationMeta: runs.conversationMeta,
  };
}

export function periodHeader(period: Period) {
  return { from: period.from, to: period.to, label: period.label, days: period.days };
}

export const TRUNCATED_NOTE =
  "Resultado parcial: o volume do período passou do teto de linhas. Reduza o período para números completos.";

export function notes(truncated: boolean, extra: string[] = []): string[] {
  return truncated ? [TRUNCATED_NOTE, ...extra] : extra;
}

/** Schema com só o período (+ campos extras). */
export function schemaWithPeriod(
  description: string,
  extra: Record<string, unknown> = {},
  required: string[] = [],
): JsonSchemaObject {
  return {
    type: "object",
    description,
    properties: { period: PERIOD_SCHEMA, ...extra },
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

export const UUID_SCHEMA = { type: "string", format: "uuid" } as const;
