import { describe, expect, it } from "vitest";
import { parseReasonForm, endKindLabel, formatClock, formatPauseDuration, pauseElapsedSeconds, pauseErrorMessage, pauseLevel } from "./pause";

describe("pauseLevel", () => {
  it("sem limite nunca alerta", () => {
    expect(pauseLevel(99999, null)).toBe("ok");
  });
  it("âmbar acima do limite e vermelho acima do dobro", () => {
    expect(pauseLevel(3600, 60)).toBe("ok");
    expect(pauseLevel(3601, 60)).toBe("late");
    expect(pauseLevel(7200, 60)).toBe("late");
    expect(pauseLevel(7201, 60)).toBe("critical");
  });
});

describe("formatação", () => {
  it("cronômetro", () => {
    expect(formatClock(425)).toBe("07:05");
    expect(formatClock(3729)).toBe("1:02:09");
    expect(formatClock(-3)).toBe("00:00");
  });
  it("duração curta", () => {
    expect(formatPauseDuration(45)).toBe("45 s");
    expect(formatPauseDuration(23 * 60)).toBe("23 min");
    expect(formatPauseDuration(65 * 60)).toBe("1 h 05");
    expect(formatPauseDuration(120 * 60)).toBe("2 h");
  });
  it("tempo decorrido não fica negativo", () => {
    expect(pauseElapsedSeconds("2026-10-15T12:00:10.000Z", Date.parse("2026-10-15T12:00:00.000Z"))).toBe(0);
    expect(pauseElapsedSeconds("2026-10-15T12:00:00.000Z", Date.parse("2026-10-15T12:01:30.000Z"))).toBe(90);
  });
});

describe("textos", () => {
  it("rótulo do fim", () => {
    expect(endKindLabel(null)).toBe("Em andamento");
    expect(endKindLabel("desconexao")).toBe("Encerrada por desconexão");
  });
  it("erros em português", () => {
    expect(pauseErrorMessage("other_team")).toMatch(/suas equipes/);
    expect(pauseErrorMessage("zzz", "x")).toBe("x");
    expect(pauseErrorMessage(undefined)).toMatch(/Tente de novo/);
  });
});

describe("parseReasonForm", () => {
  it("aceita nome e tempo, ou sem limite", () => {
    expect(parseReasonForm(" Almoço ", "60")).toEqual({ ok: true, body: { name: "Almoço", max_minutes: 60 } });
    expect(parseReasonForm("Outro", "")).toEqual({ ok: true, body: { name: "Outro", max_minutes: null } });
  });
  it("recusa nome vazio, tempo inválido e fora da faixa", () => {
    expect(parseReasonForm("  ", "")).toMatchObject({ ok: false });
    expect(parseReasonForm("A", "abc")).toMatchObject({ ok: false });
    expect(parseReasonForm("A", "0")).toMatchObject({ ok: false });
    expect(parseReasonForm("A", "1441")).toMatchObject({ ok: false });
    expect(parseReasonForm("x".repeat(41), "")).toMatchObject({ ok: false });
  });
});
