// compare_institutions — dimensão = Cliente de /canais (wacrm.clients).

import { computeInstitutions } from "../compute/institutions";
import { loadClientNames, loadPeriodConversations } from "../data";
import { resolvePeriod, type PeriodInput } from "../period";
import { loadFacts, notes, periodHeader, schemaWithPeriod } from "./shared";
import { defineTool } from "./types";
import { asObject, periodField } from "./validate";

export const compareInstitutions = defineTool({
  name: "compare_institutions",
  description:
    "Compara as instituições (Clientes cadastrados em /canais; vêm da linha/canal da conversa) no período: conversas recebidas, finalizadas, em aberto, 1ª resposta (média e p90) e IA (execuções encerradas, transferência para humano, contenção). Conversas sem cliente aparecem como \"Sem cliente\".",
  inputSchema: schemaWithPeriod("Período da comparação."),
  validate(input: unknown): { period: PeriodInput } {
    const obj = asObject(input, ["period"]);
    return { period: periodField(obj) };
  },
  async run(scope, input, ctx) {
    const period = resolvePeriod(input.period, ctx.nowMs);
    const [conv, loaded] = await Promise.all([
      loadPeriodConversations(ctx.db, scope, period),
      loadFacts(scope, period, ctx, { withConversationMeta: true }),
    ]);
    const runClient = new Map<string, string | null>();
    for (const [id, meta] of loaded.conversationMeta ?? new Map()) runClient.set(id, meta.client_id);
    const clientIds = [...conv.rows.map((r) => r.client_id), ...runClient.values()].filter(
      (id): id is string => !!id,
    );
    const names = await loadClientNames(ctx.db, scope, clientIds);
    const truncated = conv.truncated || loaded.truncated;
    return {
      period: periodHeader(period),
      institutions: computeInstitutions(conv.rows, loaded.facts, runClient, period, names),
      truncated,
      notes: notes(truncated),
    };
  },
});
