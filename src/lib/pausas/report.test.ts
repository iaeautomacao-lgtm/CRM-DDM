import { describe, expect, it } from "vitest";
import { buildPauseReportQuery, pauseReportRangeError, reportDays } from "./report";

const base = { dateFrom: "2026-10-01", dateTo: "2026-10-15", teamId: null, userId: null, reasonId: null };

describe("buildPauseReportQuery", () => {
  it("só o período quando não há outros filtros", () => {
    expect(buildPauseReportQuery(base)).toBe("de=2026-10-01&ate=2026-10-15");
  });
  it("inclui filtros, detalhe, limite e cursor", () => {
    const qs = new URLSearchParams(
      buildPauseReportQuery(
        { ...base, teamId: "t1", userId: "u1", reasonId: "r1" },
        { detail: true, limit: 100, cursor: "abc" },
      ),
    );
    expect(Object.fromEntries(qs)).toEqual({
      de: "2026-10-01",
      ate: "2026-10-15",
      equipe: "t1",
      atendente: "u1",
      motivo: "r1",
      detalhe: "1",
      limite: "100",
      cursor: "abc",
    });
  });
});

describe("período", () => {
  it("conta as duas pontas", () => {
    expect(reportDays("2026-10-01", "2026-10-01")).toBe(1);
    expect(reportDays("2026-10-01", "2026-10-15")).toBe(15);
  });
  it("valida os limites", () => {
    expect(pauseReportRangeError("2026-10-01", "2026-10-15")).toBeNull();
    expect(pauseReportRangeError("2026-10-15", "2026-10-01")).toMatch(/anterior/);
    expect(pauseReportRangeError("2026-01-01", "2026-10-01")).toMatch(/92 dias/);
    expect(pauseReportRangeError("", "2026-10-01")).toMatch(/duas datas/);
  });
});
