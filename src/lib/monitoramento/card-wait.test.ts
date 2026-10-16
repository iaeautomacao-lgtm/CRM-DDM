import { describe, expect, it } from "vitest";
import { cardWait, cardWaitSince } from "./card-wait";

const NOW = Date.parse("2026-10-16T15:00:00Z");
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("cardWaitSince", () => {
  it("espera = última mensagem é do cliente", () => {
    const at = minsAgo(10);
    expect(cardWaitSince({ status: "open", last_message_at: at, last_customer_message_at: at })).toBe(Date.parse(at));
  });

  it("atendente respondeu depois do cliente: não está esperando", () => {
    expect(cardWaitSince({ status: "open", last_message_at: minsAgo(1), last_customer_message_at: minsAgo(10) })).toBeNull();
  });

  it("fechada, ou sem as datas (consulta antiga / evento sem elas): sem selo", () => {
    expect(cardWaitSince({ status: "closed", last_message_at: minsAgo(10), last_customer_message_at: minsAgo(10) })).toBeNull();
    expect(cardWaitSince({ status: "open" })).toBeNull();
    expect(cardWaitSince({ status: "pending", last_message_at: null, last_customer_message_at: null })).toBeNull();
  });
});

describe("cardWait (SLA da equipe)", () => {
  it("no prazo, atrasado a partir do SLA e crítico a partir do dobro", () => {
    expect(cardWait(NOW - 9 * 60_000, NOW, 10)).toEqual({ minutes: 9, level: "ok" });
    expect(cardWait(NOW - 10 * 60_000, NOW, 10)).toEqual({ minutes: 10, level: "late" });
    expect(cardWait(NOW - 19 * 60_000, NOW, 10).level).toBe("late");
    expect(cardWait(NOW - 20 * 60_000, NOW, 10).level).toBe("critical");
  });

  it("o mesmo tempo muda de nível conforme o SLA da equipe", () => {
    const since = NOW - 20 * 60_000;
    expect(cardWait(since, NOW, 15).level).toBe("late"); // padrão
    expect(cardWait(since, NOW, 30).level).toBe("ok"); // equipe com SLA maior
    expect(cardWait(since, NOW, 5).level).toBe("critical"); // equipe com SLA menor
  });
});
