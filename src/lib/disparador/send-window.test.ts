import { describe, expect, it } from "vitest";
import { isWithinSendWindow, nextWindowStart, parseHHMM } from "./send-window";

// Horário de Brasília → instante UTC (BR = UTC-3).
const br = (hh: number, mm = 0) => new Date(Date.UTC(2026, 9, 15, hh + 3, mm));

describe("janela de envio", () => {
  it("janela comum", () => {
    expect(isWithinSendWindow("08:00", "18:00", br(9))).toBe(true);
    expect(isWithinSendWindow("08:00", "18:00", br(7, 59))).toBe(false);
    expect(isWithinSendWindow("08:00", "18:00", br(18, 1))).toBe(false);
  });
  it("00:00–23:59 e sem janela = dia todo", () => {
    expect(isWithinSendWindow("00:00", "23:59", br(23, 30))).toBe(true);
    expect(isWithinSendWindow(null, null, br(3))).toBe(true);
    expect(isWithinSendWindow("lixo", "18:00", br(3))).toBe(true);
  });
  it("cruza a meia-noite", () => {
    expect(isWithinSendWindow("20:00", "02:00", br(23))).toBe(true);
    expect(isWithinSendWindow("20:00", "02:00", br(1))).toBe(true);
    expect(isWithinSendWindow("20:00", "02:00", br(12))).toBe(false);
  });
  it("próxima abertura: hoje se ainda não abriu, senão amanhã", () => {
    expect(nextWindowStart("08:00", br(6)).toISOString()).toBe(br(8).toISOString());
    expect(nextWindowStart("08:00", br(19)).toISOString()).toBe(new Date(br(8).getTime() + 86_400_000).toISOString());
  });
  it("parseHHMM", () => {
    expect(parseHHMM("8:05")).toBe(485);
    expect(parseHHMM("24:00")).toBeNull();
  });
});
