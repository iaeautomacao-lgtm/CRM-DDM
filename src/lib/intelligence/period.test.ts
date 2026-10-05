import { describe, expect, it } from "vitest";
import { BadRequestError } from "./errors";
import { brazilDay, MAX_PERIOD_DAYS, previousPeriod, resolvePeriod, validatePeriodInput } from "./period";

// 05/10/2026 09:00 em Brasília.
const NOW = Date.parse("2026-10-05T12:00:00Z");

describe("resolvePeriod — presets (Brasília, UTC-3)", () => {
  it("today começa à meia-noite de Brasília (03:00Z) e termina exclusivo no dia seguinte", () => {
    const p = resolvePeriod({ preset: "today" }, NOW);
    expect(p.from).toBe("2026-10-05T03:00:00.000Z");
    expect(p.to).toBe("2026-10-06T03:00:00.000Z");
    expect(p.days).toBe(1);
    expect(p.label).toContain("05/10/2026");
  });

  it("23:30 em Brasília ainda é o mesmo dia (02:30Z do dia seguinte em UTC)", () => {
    const p = resolvePeriod({ preset: "today" }, Date.parse("2026-10-06T02:30:00Z"));
    expect(p.from).toBe("2026-10-05T03:00:00.000Z");
  });

  it("yesterday, last_7_days, previous_7_days, last_30_days", () => {
    expect(resolvePeriod({ preset: "yesterday" }, NOW)).toMatchObject({
      from: "2026-10-04T03:00:00.000Z",
      to: "2026-10-05T03:00:00.000Z",
      days: 1,
    });
    expect(resolvePeriod({ preset: "last_7_days" }, NOW)).toMatchObject({
      from: "2026-09-29T03:00:00.000Z",
      to: "2026-10-06T03:00:00.000Z",
      days: 7,
    });
    expect(resolvePeriod({ preset: "previous_7_days" }, NOW)).toMatchObject({
      from: "2026-09-22T03:00:00.000Z",
      to: "2026-09-29T03:00:00.000Z",
      days: 7,
    });
    expect(resolvePeriod({ preset: "last_30_days" }, NOW).days).toBe(30);
  });

  it("this_month vai até amanhã; last_month é o mês anterior inteiro", () => {
    expect(resolvePeriod({ preset: "this_month" }, NOW)).toMatchObject({
      from: "2026-10-01T03:00:00.000Z",
      to: "2026-10-06T03:00:00.000Z",
      days: 5,
    });
    expect(resolvePeriod({ preset: "last_month" }, NOW)).toMatchObject({
      from: "2026-09-01T03:00:00.000Z",
      to: "2026-10-01T03:00:00.000Z",
      days: 30,
    });
    // Virada de ano.
    expect(resolvePeriod({ preset: "last_month" }, Date.parse("2027-01-10T12:00:00Z"))).toMatchObject({
      from: "2026-12-01T03:00:00.000Z",
      to: "2027-01-01T03:00:00.000Z",
    });
  });

  it("sem nada informado = últimos 7 dias", () => {
    expect(resolvePeriod({}, NOW)).toEqual(resolvePeriod({ preset: "last_7_days" }, NOW));
  });
});

describe("resolvePeriod — datas explícitas", () => {
  it("date_to é inclusivo", () => {
    const p = resolvePeriod({ date_from: "2026-10-01", date_to: "2026-10-03" }, NOW);
    expect(p.from).toBe("2026-10-01T03:00:00.000Z");
    expect(p.to).toBe("2026-10-04T03:00:00.000Z");
    expect(p.days).toBe(3);
    expect(p.label).toBe("01/10/2026 a 03/10/2026");
  });

  it("date_from sozinho vai até hoje", () => {
    expect(resolvePeriod({ date_from: "2026-10-01" }, NOW).to).toBe("2026-10-06T03:00:00.000Z");
  });

  it(`aceita exatamente ${MAX_PERIOD_DAYS} dias e recusa ${MAX_PERIOD_DAYS + 1}`, () => {
    // 31 + 28 + 31 + 2 = 92
    expect(resolvePeriod({ date_from: "2026-01-01", date_to: "2026-04-02" }, NOW).days).toBe(92);
    expect(() => resolvePeriod({ date_from: "2026-01-01", date_to: "2026-04-03" }, NOW)).toThrow(BadRequestError);
  });

  it("recusa período invertido, data inexistente, date_to sem date_from e preset + datas", () => {
    expect(() => resolvePeriod({ date_from: "2026-10-03", date_to: "2026-10-01" }, NOW)).toThrow(/anterior/);
    expect(() => resolvePeriod({ date_from: "2026-02-30" }, NOW)).toThrow(BadRequestError);
    expect(() => resolvePeriod({ date_to: "2026-10-01" }, NOW)).toThrow(/date_from/);
    expect(() => resolvePeriod({ preset: "today", date_from: "2026-10-01" }, NOW)).toThrow(/OU/);
  });
});

describe("validatePeriodInput", () => {
  it("recusa campos desconhecidos, preset inválido e formato errado", () => {
    expect(() => validatePeriodInput({ account_id: "x" })).toThrow(/não permitido/);
    expect(() => validatePeriodInput({ preset: "last_year" })).toThrow(/preset/);
    expect(() => validatePeriodInput({ date_from: "01/10/2026" })).toThrow(/YYYY-MM-DD/);
    expect(() => validatePeriodInput("last_7_days")).toThrow(/objeto/);
    expect(validatePeriodInput(undefined)).toEqual({});
  });
});

describe("previousPeriod", () => {
  it("mesma duração, imediatamente antes", () => {
    const prev = previousPeriod(resolvePeriod({ preset: "last_7_days" }, NOW));
    expect(prev.from).toBe("2026-09-22T03:00:00.000Z");
    expect(prev.to).toBe("2026-09-29T03:00:00.000Z");
    expect(prev.days).toBe(7);
    expect(prev.label).toContain("22/09/2026 a 28/09/2026");
  });
});

describe("brazilDay", () => {
  it("usa o calendário de Brasília", () => {
    expect(brazilDay("2026-10-06T02:59:59Z")).toBe("2026-10-05");
    expect(brazilDay("2026-10-06T03:00:00Z")).toBe("2026-10-06");
  });
});
