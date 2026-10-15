import { describe, expect, it } from "vitest";
import { awaitingReplySince, formatWait, waitLevel, waitMinutes } from "./wait-time";

const T = "2026-10-15T12:00:00.000Z";

describe("awaitingReplySince", () => {
  it("espera quando a última mensagem é do cliente", () => {
    expect(awaitingReplySince({ status: "open", last_message_at: T, last_customer_message_at: T })).toBe(Date.parse(T));
  });
  it("tolera pequena diferença entre as datas", () => {
    expect(
      awaitingReplySince({ status: "open", last_message_at: "2026-10-15T12:00:02.000Z", last_customer_message_at: T }),
    ).toBe(Date.parse(T));
  });
  it("não espera quando alguém respondeu depois", () => {
    expect(
      awaitingReplySince({ status: "open", last_message_at: "2026-10-15T12:05:00.000Z", last_customer_message_at: T }),
    ).toBeNull();
  });
  it("não espera se encerrada ou sem mensagem do cliente", () => {
    expect(awaitingReplySince({ status: "closed", last_message_at: T, last_customer_message_at: T })).toBeNull();
    expect(awaitingReplySince({ status: "open", last_message_at: T, last_customer_message_at: null })).toBeNull();
  });
});

describe("formatWait", () => {
  it("formata curto", () => {
    expect(formatWait(0)).toBe("agora");
    expect(formatWait(3)).toBe("3 min");
    expect(formatWait(60)).toBe("1 h");
    expect(formatWait(80)).toBe("1 h 20");
    expect(formatWait(48 * 60)).toBe("2 d");
  });
});

describe("waitLevel / waitMinutes", () => {
  it("classifica pelo limite", () => {
    expect(waitLevel(14, 15)).toBe("ok");
    expect(waitLevel(15, 15)).toBe("late");
    expect(waitLevel(30, 15)).toBe("critical");
  });
  it("não fica negativo", () => {
    expect(waitMinutes(2000, 1000)).toBe(0);
    expect(waitMinutes(0, 180_000)).toBe(3);
  });
});
