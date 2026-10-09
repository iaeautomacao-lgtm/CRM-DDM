import { describe, expect, it } from "vitest";
import {
  formatAvgCharges,
  describeOffset,
  formatCents,
  formatCivilDate,
  formatOffset,
  maxPlaceholder,
  rulerState,
  variableKey,
} from "./client-types";

describe("regua client-types", () => {
  it("formata deslocamentos", () => {
    expect(formatOffset(-3)).toBe("D-3");
    expect(formatOffset(0)).toBe("D0");
    expect(formatOffset(2)).toBe("D+2");
    expect(describeOffset(-1)).toBe("1 dia antes do vencimento");
    expect(describeOffset(5)).toBe("5 dias depois do vencimento");
    expect(describeOffset(0)).toBe("No dia do vencimento");
  });
  it("estado da régua", () => {
    expect(rulerState({ active: false, dry_run: true })).toBe("off");
    expect(rulerState({ active: true, dry_run: true })).toBe("simulation");
    expect(rulerState({ active: true, dry_run: false })).toBe("live");
  });
  it("datas e valores sem fuso", () => {
    expect(formatCivilDate("2026-10-20")).toBe("20/10/2026");
    expect(formatCivilDate(null)).toBe("—");
    expect(formatCents(null)).toBe("—");
    expect(formatCents(123456)).toContain("1.234,56");
  });
  it("conta variáveis e chaves", () => {
    expect(maxPlaceholder("Olá {{1}}, vence {{3}}")).toBe(3);
    expect(maxPlaceholder(null)).toBe(0);
    expect(variableKey({ type: "debt_field", field: "amount" })).toBe("debt:amount");
    expect(variableKey({ type: "static", value: "x" })).toBe("static");
    expect(variableKey(undefined)).toBe("");
  });
});


describe("regua relatório", () => {
  it("formata a média de cobranças até o pagamento", () => {
    expect(formatAvgCharges(null)).toBe("—");
    expect(formatAvgCharges(2)).toBe("2");
    expect(formatAvgCharges(2.46)).toBe("2,5");
  });
});
