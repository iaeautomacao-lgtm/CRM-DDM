import { describe, expect, it } from "vitest";
import {
  costReportPath,
  currentMonthSP,
  formatUsd,
  monthLabel,
  monthOptions,
  parseRateNumber,
  rateStatuses,
  rowAmountLabel,
  todaySP,
  validateRateForm,
} from "./ai-costs-ui";

const form = { sku: "openai:gpt-4o-mini", effective_from: "2026-10-20", input: "0,15", cached: "", output: "0.60" };

describe("meses", () => {
  it("usa o fuso de São Paulo na virada do mês", () => {
    // 01/11 02:00 UTC ainda é 31/10 23:00 em São Paulo.
    expect(currentMonthSP(new Date("2026-11-01T02:00:00Z"))).toBe("2026-10");
    expect(todaySP(new Date("2026-11-01T02:00:00Z"))).toBe("2026-10-31");
  });
  it("lista meses do atual para trás, atravessando o ano", () => {
    expect(monthOptions("2026-02", 4)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
  });
  it("rotula em português e monta a rota só com mês válido", () => {
    expect(monthLabel("2026-10")).toBe("Outubro de 2026");
    expect(costReportPath("2026-10")).toBe("/api/costs/ai?month=2026-10");
    expect(costReportPath("2026-10", "csv")).toBe("/api/costs/ai?month=2026-10&format=csv");
    expect(() => costReportPath("2026-13")).toThrow();
    expect(() => costReportPath("../x")).toThrow();
  });
});

describe("valores", () => {
  it("formata USD com 2 a 4 casas", () => {
    expect(formatUsd(1.5)).toMatch(/1,50/);
    expect(formatUsd(0.01234)).toMatch(/0,0123/);
  });
  it("sem tarifa nunca vira zero", () => {
    expect(rowAmountLabel({ requests: 10, unpriced: 10, priced_usd: 0 })).toBe("Sem tarifa");
    expect(rowAmountLabel({ requests: 10, unpriced: 3, priced_usd: 0.5 })).toMatch(/0,50/);
    expect(rowAmountLabel({ requests: 10, unpriced: 0, priced_usd: 0 })).toMatch(/0,00/);
  });
});

describe("situação das tarifas", () => {
  it("marca em vigor, anterior e agendada por modelo", () => {
    const st = rateStatuses([
      { sku: "a", effective_from: "2026-12-01", locked: false },
      { sku: "a", effective_from: "2026-10-01", locked: true },
      { sku: "a", effective_from: "2026-01-01", locked: true },
      { sku: "b", effective_from: "2026-02-01", locked: true },
    ]);
    expect(st).toEqual(["scheduled", "current", "previous", "current"]);
  });
});

describe("formulário de tarifa", () => {
  it("aceita vírgula ou ponto e cache em branco", () => {
    expect(parseRateNumber("0,15")).toBe(0.15);
    expect(parseRateNumber("0.6")).toBe(0.6);
    expect(parseRateNumber("  ")).toBeNull();
    expect(parseRateNumber("abc")).toBeNaN();
    expect(parseRateNumber("-1")).toBeNaN();
  });
  it("monta o corpo do PUT", () => {
    expect(validateRateForm(form, "2026-10-16")).toEqual({
      ok: true,
      body: { sku: "openai:gpt-4o-mini", effective_from: "2026-10-20", input_per_million: 0.15, cached_input_per_million: null, output_per_million: 0.6 },
    });
  });
  it("normaliza o modelo para minúsculo", () => {
    const r = validateRateForm({ ...form, sku: " OpenAI:GPT-4o-Mini " }, "2026-10-16");
    expect(r.ok && r.body.sku).toBe("openai:gpt-4o-mini");
  });
  it("recusa modelo, data e valores inválidos, e passado anterior ao mês atual", () => {
    const bad = (patch: Partial<typeof form>) => validateRateForm({ ...form, ...patch }, "2026-10-16");
    expect(bad({ sku: "gpt-4o" }).ok).toBe(false);
    expect(bad({ sku: "foo:bar" }).ok).toBe(false);
    expect(bad({ effective_from: "" }).ok).toBe(false);
    expect(bad({ effective_from: "2026-09-30" }).ok).toBe(false);
    expect(bad({ effective_from: "2026-10-01" }).ok).toBe(true);
    expect(bad({ input: "" }).ok).toBe(false);
    expect(bad({ output: "x" }).ok).toBe(false);
    expect(bad({ cached: "x" }).ok).toBe(false);
    expect(bad({ input: "100001" }).ok).toBe(false);
  });
});
