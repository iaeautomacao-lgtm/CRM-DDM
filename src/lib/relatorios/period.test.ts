import { describe, expect, it } from "vitest";
import { matchPreset, normalizeRange, presetRange } from "./period";

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

describe("matchPreset / normalizeRange", () => {
  it("reconhece o atalho do período", () => {
    expect(matchPreset({ dateFrom: "2026-10-01", dateTo: "2026-10-15" }, now)).toBe("mes");
    expect(matchPreset({ dateFrom: "2026-10-02", dateTo: "2026-10-15" }, now)).toBeNull();
  });
  it("troca de/até invertidos", () => {
    expect(normalizeRange({ dateFrom: "2026-10-15", dateTo: "2026-10-01" })).toEqual({ dateFrom: "2026-10-01", dateTo: "2026-10-15" });
  });
});
