import { describe, expect, it } from "vitest";
import {
  brasiliaLocalToIso,
  canSendNow,
  formatBrasilia,
  isAllowedDay,
  isWithinSendWindow,
  nextSendSlot,
  nextWindowStart,
  parseHHMM,
} from "./send-window";

describe("agendamento em horário de Brasília", () => {
  it("datetime-local vira ISO com -03:00, independente do fuso do navegador", () => {
    expect(brasiliaLocalToIso("2026-10-06T14:30")).toBe("2026-10-06T17:30:00.000Z");
    expect(brasiliaLocalToIso("2026-10-06T22:15:30")).toBe("2026-10-07T01:15:30.000Z");
  });
  it("inválido = null", () => {
    expect(brasiliaLocalToIso("")).toBeNull();
    expect(brasiliaLocalToIso("06/10/2026 14:30")).toBeNull();
    expect(brasiliaLocalToIso(null)).toBeNull();
  });
  it("formatBrasilia exibe em BRT", () => {
    expect(formatBrasilia("2026-10-06T17:30:00.000Z")).toBe("06/10/2026, 14:30");
    expect(formatBrasilia("lixo")).toBe("");
  });
});

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
    // coluna time do Postgres volta com segundos
    expect(parseHHMM("08:00:00")).toBe(480);
    expect(parseHHMM("18:30:00.000")).toBe(1110);
    expect(isWithinSendWindow("08:00:00", "18:00:00", br(3))).toBe(false);
    expect(isWithinSendWindow("08:00:00", "18:00:00", br(9))).toBe(true);
  });
});

describe("dias da semana", () => {
  // 15/10/2026 é quinta-feira (4); 17 sábado; 19 segunda.
  const at = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 9, day, hh + 3, mm));
  it("dia permitido", () => {
    expect(isAllowedDay([1, 2, 3, 4, 5], at(15, 10))).toBe(true);
    expect(isAllowedDay([1, 2, 3, 4, 5], at(17, 10))).toBe(false);
    expect(isAllowedDay(null, at(17, 10))).toBe(true);
    expect(canSendNow({ inicio: "08:00", fim: "18:00", dias: [1, 2, 3, 4, 5] }, at(17, 10))).toBe(false);
  });
  it("sábado → segunda no início da janela", () => {
    expect(nextSendSlot({ inicio: "08:00", fim: "18:00", dias: [1, 2, 3, 4, 5] }, at(17, 10)).toISOString()).toBe(at(19, 8).toISOString());
  });
  it("sexta depois da janela → segunda", () => {
    expect(nextSendSlot({ inicio: "08:00", fim: "18:00", dias: [1, 2, 3, 4, 5] }, at(16, 19)).toISOString()).toBe(at(19, 8).toISOString());
  });
  it("sem janela: meia-noite do próximo dia permitido", () => {
    expect(nextSendSlot({ dias: [1] }, at(17, 10)).toISOString()).toBe(at(19, 0).toISOString());
  });
  it("dia e horário ok: agora", () => {
    const now = at(15, 10);
    expect(nextSendSlot({ inicio: "08:00", fim: "18:00", dias: [4] }, now).toISOString()).toBe(now.toISOString());
  });
});
