import { describe, expect, it } from "vitest";
import { matchPreset, presetRange, rangeError } from "./period";

// 15/10/2026 (quinta), meio-dia local.
const now = new Date(2026, 9, 15, 12, 0, 0);

describe("presetRange", () => {
  it("calcula os atalhos", () => {
    expect(presetRange("hoje", now)).toEqual({ dateFrom: "2026-10-15", dateTo: "2026-10-15" });
    expect(presetRange("ontem", now)).toEqual({ dateFrom: "2026-10-14", dateTo: "2026-10-14" });
    expect(presetRange("7d", now)).toEqual({ dateFrom: "2026-10-09", dateTo: "2026-10-15" });
    expect(presetRange("30d", now)).toEqual({ dateFrom: "2026-09-16", dateTo: "2026-10-15" });
    expect(presetRange("mes", now)).toEqual({ dateFrom: "2026-10-01", dateTo: "2026-10-15" });
    expect(presetRange("mes_passado", now)).toEqual({ dateFrom: "2026-09-01", dateTo: "2026-09-30" });
  });
  it("mês passado em janeiro cai em dezembro do ano anterior", () => {
    expect(presetRange("mes_passado", new Date(2027, 0, 10))).toEqual({ dateFrom: "2026-12-01", dateTo: "2026-12-31" });
  });
});

describe("matchPreset / rangeError", () => {
  it("reconhece o atalho do período", () => {
    expect(matchPreset({ dateFrom: "2026-10-01", dateTo: "2026-10-15" }, now)).toBe("mes");
    expect(matchPreset({ dateFrom: "2026-10-02", dateTo: "2026-10-15" }, now)).toBeNull();
  });
  it("não troca as pontas em silêncio: devolve o motivo do erro", () => {
    expect(rangeError({ dateFrom: "2026-10-01", dateTo: "2026-10-15" })).toBeNull();
    expect(rangeError({ dateFrom: "2026-10-01", dateTo: "2026-10-01" })).toBeNull();
    expect(rangeError({ dateFrom: "2026-10-15", dateTo: "2026-10-01" })).toBe("A data inicial deve ser igual ou anterior à final.");
    expect(rangeError({ dateFrom: "", dateTo: "2026-10-01" })).toBe("Informe a data inicial.");
    expect(rangeError({ dateFrom: "2026-10-01", dateTo: "" })).toBe("Informe a data final.");
    expect(rangeError({ dateFrom: "2026-13-45", dateTo: "2026-10-01" })).toBe("Data inicial inválida.");
  });
});
