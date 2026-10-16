import { describe, expect, it } from "vitest";
import { COST_ESTIMATE_NOTICE, aiCostReportCsv, normalizeAiCostReport } from "./report";

describe("relatório de custo de IA", () => {
  const rows = { ai: [{ sku: "openai:gpt-4o-mini", requests: "3", input_tokens: "100", output_tokens: 20, cached_input_tokens: 0, priced_usd: "0.5", unpriced: 1 }, { sku: "=cmd|calc", requests: 1 }] };

  it("normaliza, soma e se declara estimativa em USD", () => {
    const r = normalizeAiCostReport("2026-10", rows, [{ sku: "openai:gpt-4o-mini", effective_from: "2026-10-01", input_per_million: "1", output_per_million: 2, cached_input_per_million: null }]);
    expect(r.estimate).toBe(true);
    expect(r.currency).toBe("USD");
    expect(r.notice).toBe(COST_ESTIMATE_NOTICE);
    expect(r.totals).toMatchObject({ requests: 4, input_tokens: 100, priced_usd: 0.5, unpriced: 1 });
    expect(r.rates[0]).toEqual({ sku: "openai:gpt-4o-mini", currency: "USD", effective_from: "2026-10-01", input_per_million: 1, cached_input_per_million: null, output_per_million: 2 });
  });
  it("entrada inválida vira relatório vazio", () => {
    expect(normalizeAiCostReport("2026-10", null, undefined)).toMatchObject({ ai: [], rates: [], totals: { requests: 0, priced_usd: 0 } });
  });
  it("CSV protege contra injeção de fórmula e traz o aviso de estimativa", () => {
    const csv = aiCostReportCsv(normalizeAiCostReport("2026-10", rows, []));
    expect(csv).toContain(`"'=cmd|calc"`);
    expect(csv).toContain("Observacao: Valores estimados");
    expect(csv.startsWith("﻿")).toBe(true);
  });
});
