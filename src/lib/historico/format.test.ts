import { describe, expect, it } from "vitest";
import { formatDuration, periodStartIso } from "./format";

describe("formatDuration", () => {
  it("formata minutos, horas e dias", () => {
    expect(formatDuration("2026-10-09T10:00:00Z", "2026-10-09T10:00:20Z")).toBe("< 1 min");
    expect(formatDuration("2026-10-09T10:00:00Z", "2026-10-09T10:12:00Z")).toBe("12 min");
    expect(formatDuration("2026-10-09T10:00:00Z", "2026-10-09T13:05:00Z")).toBe("3 h 05 min");
    expect(formatDuration("2026-10-09T10:00:00Z", "2026-10-11T14:00:00Z")).toBe("2 d 4 h");
  });
  it("devolve null sem data ou com intervalo negativo", () => {
    expect(formatDuration(null, "2026-10-09T10:00:00Z")).toBeNull();
    expect(formatDuration("2026-10-09T11:00:00Z", "2026-10-09T10:00:00Z")).toBeNull();
  });
});

describe("periodStartIso", () => {
  const now = new Date("2026-10-09T15:00:00Z");
  it("todas = sem limite", () => expect(periodStartIso("todas", now)).toBeNull());
  it("7d e 30d recuam os dias", () => {
    expect(periodStartIso("7d", now)).toBe("2026-10-02T15:00:00.000Z");
    expect(periodStartIso("30d", now)).toBe("2026-09-09T15:00:00.000Z");
  });
});
