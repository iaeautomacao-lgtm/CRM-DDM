// get_overview_metrics e compare_periods.

import { evaluateScalarMetrics } from "../metrics/evaluate";
import { getMetric, SCALAR_METRIC_IDS } from "../metrics/registry";
import { previousPeriod, resolvePeriod, type PeriodInput } from "../period";
import { diff } from "../stats";
import { notes, periodHeader, schemaWithPeriod } from "./shared";
import { defineTool } from "./types";
import { asObject, periodField, reqEnum } from "./validate";

export const getOverviewMetrics = defineTool({
  name: "get_overview_metrics",
  description:
    "Visão geral do atendimento no período: conversas recebidas, em aberto, pendentes, finalizadas, tempo de 1ª resposta humana (média e p90) e o resumo da IA nos fluxos (execuções com IA, transferência para humano, contenção, falha, sucesso das ferramentas). Use como primeira ferramenta para perguntas gerais (\"como foi a semana?\"). Todo número vem com numerator/denominator; value null = sem amostra.",
  inputSchema: schemaWithPeriod("Período da visão geral."),
  validate(input: unknown): { period: PeriodInput } {
    const obj = asObject(input, ["period"]);
    return { period: periodField(obj) };
  },
  async run(scope, input, ctx) {
    const period = resolvePeriod(input.period, ctx.nowMs);
    const ev = await evaluateScalarMetrics(SCALAR_METRIC_IDS, scope, period, ctx);
    return { period: periodHeader(period), metrics: ev.metrics, truncated: ev.truncated, notes: notes(ev.truncated) };
  },
});

export const comparePeriods = defineTool({
  name: "compare_periods",
  description:
    "Compara uma métrica do catálogo entre o período pedido e o período imediatamente anterior de mesma duração (ex.: últimos 7 dias × 7 dias antes). Devolve current, previous, diferença absoluta e percentual (fração; null quando o anterior é 0 ou sem amostra). Use para \"melhorou ou piorou?\".",
  inputSchema: schemaWithPeriod(
    "Métrica e período atual.",
    {
      metric: {
        type: "string",
        enum: SCALAR_METRIC_IDS,
        description: "Id da métrica do catálogo.",
      },
    },
    ["metric"],
  ),
  validate(input: unknown): { metric: string; period: PeriodInput } {
    const obj = asObject(input, ["metric", "period"]);
    return { metric: reqEnum(obj, "metric", SCALAR_METRIC_IDS), period: periodField(obj) };
  },
  async run(scope, input, ctx) {
    const current = resolvePeriod(input.period, ctx.nowMs);
    const previous = previousPeriod(current);
    const [cur, prev] = await Promise.all([
      evaluateScalarMetrics([input.metric], scope, current, ctx),
      evaluateScalarMetrics([input.metric], scope, previous, ctx),
    ]);
    const def = getMetric(input.metric)!;
    const c = cur.metrics[0];
    const p = prev.metrics[0];
    const d = diff(c, p);
    const truncated = cur.truncated || prev.truncated;
    return {
      metric: { id: def.id, display_name: def.display_name, unit: def.unit, version: def.version },
      current: { period: periodHeader(current), value: c.value, numerator: c.numerator, denominator: c.denominator },
      previous: { period: periodHeader(previous), value: p.value, numerator: p.numerator, denominator: p.denominator },
      abs_diff: d.abs,
      pct_diff: d.pct,
      truncated,
      notes: notes(truncated),
    };
  },
});
