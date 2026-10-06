import { describe, expect, it } from "vitest";
import {
  addOpenWindowTime,
  deferredSlot,
  lastWindowClose,
  scheduleRounds,
  windowClockTime,
} from "./window-clock";

// Horário de Brasília → instante UTC (BR = UTC-3). Outubro/2026:
// 15 = quinta, 16 = sexta, 17 = sábado, 18 = domingo, 19 = segunda.
const br = (day: number, hh: number, mm = 0, ss = 0) => new Date(Date.UTC(2026, 9, day, hh + 3, mm, ss));
const iso = (dates: Date[]) => dates.map((d) => d.toISOString());
const MIN = 60_000;

const comercial = { inicio: "08:00", fim: "18:00" };
const diasUteis = { ...comercial, dias: [1, 2, 3, 4, 5] };

describe("scheduleRounds", () => {
  it("mesmo dia: pausa no relógio comum", () => {
    expect(iso(scheduleRounds(br(15, 9), 3, 1800, comercial))).toEqual(
      iso([br(15, 9), br(15, 9, 30), br(15, 10)])
    );
  });

  it("passa do fim da janela: continua no dia seguinte mantendo o ritmo (17:45 → 08:15)", () => {
    expect(iso(scheduleRounds(br(15, 17, 15), 4, 1800, comercial))).toEqual(
      iso([br(15, 17, 15), br(15, 17, 45), br(16, 8, 15), br(16, 8, 45)])
    );
  });

  it("rodadas não se acumulam na abertura (era a rajada)", () => {
    const rounds = scheduleRounds(br(15, 17), 10, 1800, comercial);
    const nextMorning = rounds.filter((r) => r.getTime() >= br(16, 8).getTime());
    for (let k = 1; k < nextMorning.length; k++) {
      expect(nextMorning[k].getTime() - nextMorning[k - 1].getTime()).toBe(30 * MIN);
    }
    expect(new Set(rounds.map((r) => r.getTime())).size).toBe(10);
  });

  it("fim de semana excluído: sexta 17:45 → segunda 08:15", () => {
    expect(iso(scheduleRounds(br(16, 17, 45), 2, 1800, diasUteis))).toEqual(iso([br(16, 17, 45), br(19, 8, 15)]));
  });

  it("janela que cruza a meia-noite (20:00–02:00)", () => {
    const noturna = { inicio: "20:00", fim: "02:00" };
    expect(iso(scheduleRounds(br(15, 23, 45), 2, 1800, noturna))).toEqual(iso([br(15, 23, 45), br(16, 0, 15)]));
    // 01:45 + 30 min: fecha às 02:00 e reabre às 20:00 do mesmo dia
    expect(iso(scheduleRounds(br(15, 1, 45), 2, 1800, noturna))).toEqual(iso([br(15, 1, 45), br(15, 20, 15)]));
  });

  it("cruza a meia-noite com dia restrito: a madrugada pertence ao dia em que cai", () => {
    // Só quinta: Qui 23:45 + 30 → sexta 00:00 não é permitido → quinta seguinte 00:15
    const soQuinta = { inicio: "20:00", fim: "02:00", dias: [4] };
    expect(iso(scheduleRounds(br(15, 23, 45), 2, 1800, soQuinta))).toEqual(iso([br(15, 23, 45), br(22, 0, 15)]));
  });

  it("sem janela = 24h", () => {
    expect(iso(scheduleRounds(br(15, 17, 45), 2, 1800, {}))).toEqual(iso([br(15, 17, 45), br(15, 18, 15)]));
    expect(iso(scheduleRounds(br(15, 23, 45), 2, 1800, { inicio: "08:00", fim: "08:00" }))).toEqual(
      iso([br(15, 23, 45), br(16, 0, 15)])
    );
  });

  it("sem janela mas com dias: pula os dias excluídos", () => {
    expect(iso(scheduleRounds(br(16, 23, 45), 2, 1800, { dias: [1, 2, 3, 4, 5] }))).toEqual(
      iso([br(16, 23, 45), br(19, 0, 15)])
    );
  });

  it("início fora da janela: 1ª rodada na abertura seguinte", () => {
    expect(iso(scheduleRounds(br(15, 6), 2, 1800, comercial))).toEqual(iso([br(15, 8), br(15, 8, 30)]));
    expect(iso(scheduleRounds(br(15, 19), 1, 1800, comercial))).toEqual(iso([br(16, 8)]));
    // sábado com dias úteis → segunda 08:00
    expect(iso(scheduleRounds(br(17, 10), 2, 3600, diasUteis))).toEqual(iso([br(19, 8), br(19, 9)]));
  });

  it("pausa maior que a janela atravessa dias", () => {
    // 12h de pausa numa janela de 10h: 09:00 → 1h hoje + 11h... → dia seguinte 11:00
    expect(iso(scheduleRounds(br(15, 9), 2, 12 * 3600, comercial))).toEqual(iso([br(15, 9), br(16, 11)]));
  });

  it("pausa 0 = todas juntas; zero rodadas = vazio", () => {
    expect(iso(scheduleRounds(br(15, 9), 3, 0, comercial))).toEqual(iso([br(15, 9), br(15, 9), br(15, 9)]));
    expect(scheduleRounds(br(15, 9), 0, 1800, comercial)).toEqual([]);
  });
});

describe("addOpenWindowTime", () => {
  it("fim exclusivo: 17:30 + 30 min = abertura do dia seguinte", () => {
    expect(addOpenWindowTime(br(15, 17, 30), 30 * MIN, comercial).toISOString()).toBe(br(16, 8).toISOString());
  });
  it("dias inválidos: relógio comum (não trava)", () => {
    expect(addOpenWindowTime(br(15, 9), 30 * MIN, { ...comercial, dias: [9] }).toISOString()).toBe(
      br(15, 9, 30).toISOString()
    );
  });
});

describe("lastWindowClose", () => {
  it("fechamento anterior, inclusive pulando o fim de semana", () => {
    expect(lastWindowClose(br(15, 20), comercial)?.toISOString()).toBe(br(15, 18).toISOString());
    expect(lastWindowClose(br(15, 7), comercial)?.toISOString()).toBe(br(14, 18).toISOString());
    expect(lastWindowClose(br(18, 10), diasUteis)?.toISOString()).toBe(br(16, 18).toISOString());
  });
});

describe("windowClockTime (itens que venceram com a janela fechada)", () => {
  it("horário aberto fica como está (inclui o último minuto aceito pelo envio)", () => {
    expect(windowClockTime(br(15, 10), comercial).toISOString()).toBe(br(15, 10).toISOString());
    expect(windowClockTime(br(15, 18, 0, 30), comercial).toISOString()).toBe(br(15, 18, 0, 30).toISOString());
  });
  it("depois do fechamento: abertura + atraso desde o fechamento", () => {
    expect(windowClockTime(br(15, 18, 15), comercial).toISOString()).toBe(br(16, 8, 15).toISOString());
    expect(windowClockTime(br(15, 18, 45), comercial).toISOString()).toBe(br(16, 8, 45).toISOString());
  });
  it("fim de semana: sábado 10:00 (16h depois do fechamento de sexta) → terça 14:00", () => {
    // segunda 08–18 consome 10h, faltam 6h → terça 14:00
    expect(windowClockTime(br(17, 10), diasUteis).toISOString()).toBe(br(20, 14).toISOString());
  });
});

describe("deferredSlot", () => {
  it("fechado: nunca antes da próxima abertura; espaçamento preservado", () => {
    const now = br(15, 20);
    expect(deferredSlot(br(15, 18, 15), now, comercial, false)?.toISOString()).toBe(br(16, 8, 15).toISOString());
    expect(deferredSlot(br(15, 17, 59), now, comercial, false)?.toISOString()).toBe(br(16, 8).toISOString());
    expect(deferredSlot(null, now, comercial, false)?.toISOString()).toBe(br(16, 8).toISOString());
  });
  it("aberto: só adia se o horário efetivo estiver à frente", () => {
    const now = br(16, 8, 0, 30);
    expect(deferredSlot(br(15, 18, 45), now, comercial, true)?.toISOString()).toBe(br(16, 8, 45).toISOString());
    expect(deferredSlot(br(15, 18, 0, 30), now, comercial, true)).toBeNull();
    expect(deferredSlot(br(16, 8), now, comercial, true)).toBeNull();
    expect(deferredSlot(null, now, comercial, true)).toBeNull();
  });
});
