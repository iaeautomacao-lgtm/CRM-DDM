import { describe, expect, it } from "vitest";
import {
  calculateThroughputPerMinute,
  cronItemsPerMinute,
  forecastCampaign,
  forecastFromCampaign,
} from "./dispatch-forecast";

// Horários em Brasília (UTC-3 fixo). 06/10/2026 é uma terça-feira.
const br = (local: string) => new Date(`${local}:00-03:00`);
const iso = (d: Date) => d.toISOString();
const janela = { inicio: "08:00", fim: "18:00", dias: [1, 2, 3, 4, 5] };

describe("calculateThroughputPerMinute e cronItemsPerMinute", () => {
  it("calcula envios/min pela fórmula slots ÷ latência × budget", () => {
    // Meta padrão seguro: 4 slots, 0.85s, 35s budget → ~164,7/min
    expect(Math.floor(calculateThroughputPerMinute(4, 0.85, 35))).toBe(164);
    expect(cronItemsPerMinute(999_999, 0.85, null, { slots: 4, budgetSeconds: 35 })).toBe(164);

    // WAHA padrão seguro: 4 slots, 2.0s, 35s budget → 70/min
    expect(Math.floor(calculateThroughputPerMinute(4, 2.0, 35))).toBe(70);
    expect(cronItemsPerMinute(999_999, 2.0, null, { slots: 4, budgetSeconds: 35 })).toBe(70);

    // Meta com concorrência elevada: 10 slots, 0.85s, 35s budget → ~411/min
    expect(Math.floor(calculateThroughputPerMinute(10, 0.85, 35))).toBe(411);
    expect(cronItemsPerMinute(999_999, 0.85, null, { slots: 10, budgetSeconds: 35 })).toBe(411);

    // Motor novo sem teto artificial de 700: 20 slots, 0.85s, 35s budget → ~823/min
    expect(Math.floor(calculateThroughputPerMinute(20, 0.85, 35))).toBe(823);
    expect(cronItemsPerMinute(999_999, 0.85, null, { slots: 20, budgetSeconds: 35 })).toBe(823);
  });

  it("limita pela quantidade de candidatos da rodada", () => {
    expect(cronItemsPerMinute(50, 0.85, null, { slots: 4, budgetSeconds: 35 })).toBe(50);
  });

  it("limite_por_hora reduz o ritmo (pode ser fracionário)", () => {
    expect(cronItemsPerMinute(999_999, 0.85, 600, { slots: 4, budgetSeconds: 35 })).toBe(10);
    expect(cronItemsPerMinute(999_999, 0.85, 30, { slots: 4, budgetSeconds: 35 })).toBe(0.5);
  });

  it("trata valores inválidos ou zero retornando 0", () => {
    expect(calculateThroughputPerMinute(0, 0.85, 35)).toBe(0);
    expect(calculateThroughputPerMinute(4, 0, 35)).toBe(0);
    expect(calculateThroughputPerMinute(4, 0.85, 0)).toBe(0);
  });
});

describe("forecastCampaign — Imediato", () => {
  it("1.000 contatos com padrões seguros (Meta 0,85s e 2s): faixa entre 7 e 15 min", () => {
    const r = forecastCampaign({
      contacts: 1000,
      messagesPerContact: 1,
      dispatch: { mode: "imediato" },
      start: br("2026-10-06T08:00"),
      janela,
    });
    expect(r.items).toBe(1000);
    expect(r.rounds).toBe(1);
    expect(r.otimista.perMinute).toBe(164); // 4 / 0.85 * 35 = 164/min → ceil(1000/164) = 7 min
    expect(r.conservador.perMinute).toBe(70); // 4 / 2 * 35 = 70/min → ceil(1000/70) = 15 min
    expect(iso(r.otimista.end)).toBe(iso(br("2026-10-06T08:07")));
    expect(iso(r.conservador.end)).toBe(iso(br("2026-10-06T08:15")));
    expect(r.ratePerMinute).toBe(165);
  });

  it("1.000 contatos com ritmo real Meta medido (10 slots, avg 0.85s, p95 1.2s)", () => {
    const r = forecastCampaign({
      contacts: 1000,
      messagesPerContact: 1,
      dispatch: { mode: "imediato" },
      start: br("2026-10-06T08:00"),
      janela,
      throughput: {
        slots: 10,
        budgetSeconds: 35,
        latency: { otimista: 0.85, conservador: 1.2 },
      },
    });
    expect(r.otimista.perMinute).toBe(411); // 10 / 0.85 * 35 = 411/min → 3 min
    expect(r.conservador.perMinute).toBe(291); // 10 / 1.2 * 35 = 291/min → 4 min
    expect(iso(r.otimista.end)).toBe(iso(br("2026-10-06T08:03")));
    expect(iso(r.conservador.end)).toBe(iso(br("2026-10-06T08:04")));
    expect(r.ratePerMinute).toBe(412);
  });

  it("1.000 contatos com ritmo real WAHA (4 slots, avg 2.0s, p95 2.5s)", () => {
    const r = forecastCampaign({
      contacts: 1000,
      messagesPerContact: 1,
      dispatch: { mode: "imediato" },
      start: br("2026-10-06T08:00"),
      janela,
      throughput: {
        slots: 4,
        budgetSeconds: 35,
        latency: { otimista: 2.0, conservador: 2.5 },
      },
    });
    expect(r.otimista.perMinute).toBe(70); // 4 / 2 * 35 = 70/min → 15 min
    expect(r.conservador.perMinute).toBe(56); // 4 / 2.5 * 35 = 56/min → 18 min
    expect(iso(r.otimista.end)).toBe(iso(br("2026-10-06T08:15")));
    expect(iso(r.conservador.end)).toBe(iso(br("2026-10-06T08:18")));
    expect(r.ratePerMinute).toBe(70);
  });

  it("início antes da janela começa na abertura", () => {
    const r = forecastCampaign({
      contacts: 70,
      messagesPerContact: 1,
      dispatch: { mode: "imediato" },
      start: br("2026-10-06T06:30"),
      janela,
    });
    expect(iso(r.firstSendAt)).toBe(iso(br("2026-10-06T08:00")));
    expect(iso(r.conservador.end)).toBe(iso(br("2026-10-06T08:01")));
  });

  it("passa do horário na sexta: continua na segunda, no mesmo intervalo", () => {
    const r = forecastCampaign({
      contacts: 2000,
      messagesPerContact: 1,
      dispatch: { mode: "imediato" },
      start: br("2026-10-09T17:50"),
      janela,
    });
    // Conservador: 70/min → 29 min = 10 min na sexta + 19 min na segunda.
    expect(iso(r.conservador.end)).toBe(iso(br("2026-10-12T08:19")));
  });

  it("sequência de 3 mensagens por contato triplica os itens", () => {
    const r = forecastCampaign({
      contacts: 100,
      messagesPerContact: 3,
      dispatch: { mode: "imediato" },
      start: br("2026-10-06T08:00"),
      janela,
    });
    expect(r.items).toBe(300);
    expect(iso(r.conservador.end)).toBe(iso(br("2026-10-06T08:05")));
  });
});

describe("forecastCampaign — Segmentado", () => {
  it("10% a cada 30 min: 10 rodadas de 100, termina logo depois da última", () => {
    const r = forecastCampaign({
      contacts: 1000,
      messagesPerContact: 1,
      dispatch: { mode: "segmentado", percent: 10, pauseMinutes: 30 },
      start: br("2026-10-06T08:00"),
      janela,
    });
    expect(r.rounds).toBe(10);
    expect(r.contactsPerRound).toBe(100);
    expect(iso(r.lastRoundAt)).toBe(iso(br("2026-10-06T12:30")));
    expect(iso(r.otimista.end)).toBe(iso(br("2026-10-06T12:31")));
    expect(iso(r.conservador.end)).toBe(iso(br("2026-10-06T12:32")));
    expect(r.roundsOverlap).toBe(false);
  });

  it("entre dias mantém o ritmo, sem rajada na abertura", () => {
    const r = forecastCampaign({
      contacts: 1000,
      messagesPerContact: 1,
      dispatch: { mode: "segmentado", percent: 10, pauseMinutes: 120 },
      start: br("2026-10-06T16:00"),
      janela,
    });
    expect(iso(r.lastRoundAt)).toBe(iso(br("2026-10-08T14:00")));
    expect(iso(r.otimista.end)).toBe(iso(br("2026-10-08T14:01")));
  });

  it("rodada maior do que o cron envia no intervalo: avisa e enfileira", () => {
    const r = forecastCampaign({
      contacts: 10_000,
      messagesPerContact: 1,
      dispatch: { mode: "segmentado", percent: 50, pauseMinutes: 30 },
      start: br("2026-10-06T08:00"),
      janela,
    });
    expect(r.contactsPerRound).toBe(5000);
    expect(r.roundsOverlap).toBe(true);
    // Conservador: 70/min → 72 min por rodada; a 2ª espera a 1ª terminar.
    expect(r.roundDrainMinutes.max).toBe(72);
    expect(iso(r.conservador.end)).toBe(iso(br("2026-10-06T10:24")));
  });

  it("base pequena: rodada de 1 contato usa o envio sequencial", () => {
    const r = forecastCampaign({
      contacts: 5,
      messagesPerContact: 1,
      dispatch: { mode: "segmentado", percent: 10, pauseMinutes: 30 },
      start: br("2026-10-06T08:00"),
      janela,
    });
    expect(r.sequentialFallback).toBe(true);
    expect(r.rounds).toBe(5);
    expect(iso(r.conservador.end)).toBe(iso(br("2026-10-06T10:01")));
  });

  it("sem contatos: termina no início", () => {
    const r = forecastCampaign({
      contacts: 0,
      messagesPerContact: 1,
      dispatch: { mode: "imediato" },
      start: br("2026-10-06T09:00"),
      janela,
    });
    expect(r.items).toBe(0);
    expect(iso(r.otimista.end)).toBe(iso(br("2026-10-06T09:00")));
  });
});

describe("forecastFromCampaign (cards da lista)", () => {
  const start = br("2026-10-06T08:00");
  it("batch_percent → Segmentado; lote enorme sem pausa → Imediato", () => {
    const seg = forecastFromCampaign(
      { batch_percent: 10, batch_pause_seconds: 1800, batch_size: 100, janela_inicio: "08:00", janela_fim: "18:00", dias_envio: [1, 2, 3, 4, 5] },
      1000,
      1,
      start
    );
    expect(seg.rounds).toBe(10);
    const imediato = forecastFromCampaign(
      { batch_size: 999_999, batch_pause_seconds: 0, janela_inicio: "08:00", janela_fim: "18:00" },
      1000,
      1,
      start
    );
    expect(imediato.rounds).toBe(1);
  });

  it("modos antigos sequenciais (lote 1): ~1 contato por minuto", () => {
    const r = forecastFromCampaign({ batch_size: 1, batch_pause_seconds: 0, janela_inicio: "08:00", janela_fim: "18:00" }, 60, 1, start);
    expect(r.sequentialFallback).toBe(true);
    expect(iso(r.otimista.end)).toBe(iso(br("2026-10-06T09:00")));
  });
});
