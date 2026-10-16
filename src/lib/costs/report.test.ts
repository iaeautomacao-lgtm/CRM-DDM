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
  it("por funcionalidade: normaliza, ordena (valor desc, nome) e soma igual ao total; sem a 380 os campos ficam ausentes", () => {
    const n = (feature: string, usd: number, extra: Record<string, unknown> = {}) => ({ feature, requests: 1, input_tokens: 10, output_tokens: 2, cached_input_tokens: 0, priced_usd: String(usd), unpriced: 0, ...extra });
    const r = normalizeAiCostReport("2026-10", {
      ai: [{ sku: "openai:gpt-4o-mini", requests: 3, input_tokens: 30, output_tokens: 6, cached_input_tokens: 0, priced_usd: 1.5, unpriced: 0 }],
      by_feature: [n("sentiment", 0.25), n("responder", 1), n("acordo", 0.25)],
      by_feature_model: [n("sentiment", 0.25, { sku: "openai:gpt-4o-mini" }), n("responder", 0.4, { sku: "openai:b" }), n("responder", 0.6, { sku: "openai:a" }), n("acordo", 0.25, { sku: "openai:gpt-4o-mini" })],
    }, []);
    expect(r.by_feature!.map((x) => x.feature)).toEqual(["responder", "acordo", "sentiment"]);
    expect(r.by_feature!.reduce((s, x) => s + x.priced_usd, 0)).toBeCloseTo(r.totals.priced_usd, 8);
    expect(r.by_feature_model!.map((x) => `${x.feature}/${x.sku}`)).toEqual(["acordo/openai:gpt-4o-mini", "responder/openai:a", "responder/openai:b", "sentiment/openai:gpt-4o-mini"]);
    const old = normalizeAiCostReport("2026-10", rows, []);
    expect("by_feature" in old).toBe(false);
    expect("by_feature_model" in old).toBe(false);
  });
  it("CSV: o bloco por modelo continua igual e o bloco funcionalidade×modelo vem depois, com o aviso no fim", () => {
    const base = normalizeAiCostReport("2026-10", rows, []);
    const withFeature = normalizeAiCostReport("2026-10", { ...rows, by_feature_model: [{ feature: "=evil", sku: "openai:m", requests: 2, input_tokens: 5, output_tokens: 1, cached_input_tokens: 0, priced_usd: 0.1, unpriced: 0 }] }, []);
    const csvBase = aiCostReportCsv(base);
    const csv = aiCostReportCsv(withFeature);
    const baseLines = csvBase.split("\r\n").slice(0, -2); // sem a linha do aviso e sem o vazio final
    expect(csv.split("\r\n").slice(0, baseLines.length)).toEqual(baseLines);
    expect(csv).toContain("mes;funcionalidade;item;moeda;chamadas");
    expect(csv).toContain("'=evil");
    expect(csv.indexOf("funcionalidade")).toBeLessThan(csv.indexOf("Observacao"));
    expect(csvBase).not.toContain("funcionalidade");
  });
  it("CSV protege contra injeção de fórmula e traz o aviso de estimativa", () => {
    const csv = aiCostReportCsv(normalizeAiCostReport("2026-10", rows, []));
    expect(csv).toContain("'=cmd|calc");
    expect(csv).toContain("Observacao: Valores estimados");
    expect(csv.startsWith("﻿")).toBe(false); // o BOM é posto pela rota de download (CSV_BOM)
  });
});
