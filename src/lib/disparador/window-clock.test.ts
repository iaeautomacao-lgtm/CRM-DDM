import { describe, expect, it } from "vitest";
import {
  addOpenWindowTime,
  isScheduledInClosedWindow,
  INTRA_CONTACT_MS,
  lastWindowClose,
  ROUND_MAX_SPREAD_MS,
  roundContactTimeMs,
  roundSpreadOffsetMs,
  scheduleRounds,
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

describe("isScheduledInClosedWindow (detector do reflow da fila)", () => {
  const tol = 10 * MIN;
  it("horário aberto ou último minuto aceito pelo envio: consistente", () => {
    expect(isScheduledInClosedWindow(br(15, 10), comercial, tol)).toBe(false);
    expect(isScheduledInClosedWindow(br(15, 18, 0, 30), comercial, tol)).toBe(false);
  });
  it("transbordo de rodada até a tolerância: consistente", () => {
    expect(isScheduledInClosedWindow(br(15, 18, 5), comercial, tol)).toBe(false);
    expect(isScheduledInClosedWindow(br(15, 18, 15), comercial, tol)).toBe(true);
  });
  it("noite, madrugada antes da abertura e fim de semana: inconsistente", () => {
    expect(isScheduledInClosedWindow(br(15, 22), comercial, tol)).toBe(true);
    expect(isScheduledInClosedWindow(br(19, 7, 45), diasUteis, tol)).toBe(true);
    expect(isScheduledInClosedWindow(br(17, 10), diasUteis, tol)).toBe(true);
  });
  it("sem janela configurada: nunca inconsistente", () => {
    expect(isScheduledInClosedWindow(br(17, 3), {}, tol)).toBe(false);
  });
});

describe("roundSpreadOffsetMs / roundContactTimeMs (rodada vence junta)", () => {
  const minOf = (xs: number[]) => xs.reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
  const maxOf = (xs: number[]) => xs.reduce((a, b) => Math.max(a, b), Number.NEGATIVE_INFINITY);

  /** Simula o startCampaign: horário de cada item (contato × mensagem). */
  function buildQueue(contacts: number, batchSize: number, pauseSeconds: number, messages: number, janela = {}) {
    const start = br(19, 9);
    const rounds = scheduleRounds(start, Math.ceil(contacts / batchSize), pauseSeconds, janela);
    const items: Array<{ msg: number; at: number }> = [];
    for (let i = 0; i < contacts; i++) {
      const base = roundContactTimeMs(rounds, i, batchSize, contacts);
      for (let j = 0; j < messages; j++) items.push({ msg: j, at: base + j * INTRA_CONTACT_MS });
    }
    return { start, rounds, items };
  }

  it("Imediato 50 mil: a base inteira vence em < 2 s (antes 100 ms × posição ≈ 83 min)", () => {
    const { start, items } = buildQueue(50_000, 999_999, 0, 1);
    const times = items.map((x) => x.at);
    expect(minOf(times)).toBe(start.getTime());
    expect(maxOf(times) - start.getTime()).toBeLessThan(ROUND_MAX_SPREAD_MS);
    // Monótono na ordem da fila (FIFO) e empates pequenos (≈ 25 por ms),
    // para o ORDER BY (scheduled_at, id) continuar barato.
    expect(times.filter((t, k) => k > 0 && t < times[k - 1])).toHaveLength(0);
    const perMs = new Map<number, number>();
    for (const t of times) perMs.set(t, (perMs.get(t) ?? 0) + 1);
    expect(maxOf([...perMs.values()])).toBeLessThanOrEqual(25);
  });

  it("rodada pequena mantém o passo de 100 ms (≤ 20 contatos); rodada grande fica < 2 s", () => {
    expect([0, 1, 2].map((p) => roundSpreadOffsetMs(p, 3))).toEqual([0, 100, 200]);
    expect(roundSpreadOffsetMs(19, 20)).toBe(1900);
    expect(roundSpreadOffsetMs(613, 614)).toBeLessThan(ROUND_MAX_SPREAD_MS);
    expect(roundSpreadOffsetMs(0, 1)).toBe(0);
  });

  it("Segmentado: rodadas seguem a pausa em tempo aberto; cada rodada vence em < 2 s", () => {
    const janela = { inicio: "08:00", fim: "18:00", dias: [1, 2, 3, 4, 5] };
    const { rounds, items } = buildQueue(10_000, 2_500, 1800, 1, janela);
    expect(iso(rounds)).toEqual(iso([br(19, 9), br(19, 9, 30), br(19, 10), br(19, 10, 30)]));
    for (let k = 0; k < 4; k++) {
      const round = items.slice(k * 2_500, (k + 1) * 2_500).map((x) => x.at);
      expect(minOf(round)).toBe(rounds[k].getTime());
      expect(maxOf(round) - rounds[k].getTime()).toBeLessThan(ROUND_MAX_SPREAD_MS);
    }
    // Última rodada incompleta é comprimida no próprio tamanho (100 itens).
    const partial = buildQueue(2_600, 2_500, 1800, 1).items.slice(2_500).map((x) => x.at);
    expect(partial[partial.length - 1] - partial[0]).toBe(99 * 20);
  });

  it("sequência do mesmo contato: 7 s entre mensagens (131056), em ordem; todas as 1ªs vencem antes de qualquer 2ª", () => {
    expect(INTRA_CONTACT_MS).toBe(7000);
    const { items } = buildQueue(50_000, 999_999, 0, 3);
    let badGap = 0;
    for (let i = 0; i < items.length; i += 3) {
      if (items[i + 1].at - items[i].at !== INTRA_CONTACT_MS) badGap++;
      if (items[i + 2].at - items[i + 1].at !== INTRA_CONTACT_MS) badGap++;
    }
    expect(badGap).toBe(0);
    const lastFirst = maxOf(items.filter((x) => x.msg === 0).map((x) => x.at));
    const firstSecond = minOf(items.filter((x) => x.msg === 1).map((x) => x.at));
    expect(lastFirst).toBeLessThan(firstSecond);
  });
});
