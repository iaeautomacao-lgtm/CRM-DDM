import { describe, expect, it } from "vitest";
import {
  AUTO_PAUSE_DEFAULTS,
  autoPauseConfigFromEnv,
  decideAutoPause,
  type AttemptRow,
} from "./auto-pause";

const ok = (): AttemptRow => ({ status: "enviado", erro_permanente: false, erro: null });
const fail = (code = 132000): AttemptRow => ({
  status: "erro",
  erro_permanente: true,
  erro: `Template name does not exist (code ${code})`,
});
const rows = (errors: number, total: number, code?: number) => [
  ...Array.from({ length: errors }, () => fail(code)),
  ...Array.from({ length: total - errors }, ok),
];

describe("decideAutoPause", () => {
  it("abaixo do mínimo de tentativas não pausa, mesmo com 100% de erro", () => {
    expect(decideAutoPause(rows(49, 49)).pause).toBe(false);
  });

  it("primeiras 50 tentativas com >= 30% de erro pausa, com % e código", () => {
    const d = decideAutoPause(rows(15, 50, 132001));
    expect(d.pause).toBe(true);
    if (d.pause) {
      expect(d.percent).toBe(30);
      expect(d.topCode).toBe(132001);
      expect(d.reason).toMatch(/^Pausada automaticamente: 30% de erro \(código 132001\)/);
    }
  });

  it("abaixo do limite não pausa", () => {
    expect(decideAutoPause(rows(14, 50)).pause).toBe(false);
  });

  it("janela móvel: só as últimas 100 contam", () => {
    // 100 mais recentes com 10% de erro; 200 antigas com 100% de erro.
    const recent = rows(10, 100);
    const old = rows(200, 200);
    expect(decideAutoPause([...recent, ...old]).pause).toBe(false);
    // e o contrário: recentes ruins pausam mesmo com histórico bom.
    expect(decideAutoPause([...rows(40, 100), ...rows(0, 500)]).pause).toBe(true);
  });

  it("erro ainda não permanente (vai ser retentado) não conta", () => {
    const transient: AttemptRow = { status: "erro", erro_permanente: false, erro: "timeout" };
    const d = decideAutoPause([...Array.from({ length: 60 }, () => transient), ...rows(10, 50)]);
    expect(d.pause).toBe(false);
    expect(d.attempts).toBe(50);
  });

  it("bloqueado (131026) conta como erro permanente", () => {
    const blocked: AttemptRow = { status: "bloqueado", erro_permanente: true, erro: "(code 131026)" };
    const d = decideAutoPause([...Array.from({ length: 20 }, () => blocked), ...rows(0, 40)]);
    expect(d.pause).toBe(true);
    if (d.pause) expect(d.topCode).toBe(131026);
  });

  it("status fora da lista (agendado, pausado) é ignorado", () => {
    const pending: AttemptRow = { status: "agendado", erro_permanente: false, erro: null };
    expect(decideAutoPause([...Array.from({ length: 100 }, () => pending), ...rows(20, 20)]).pause).toBe(false);
  });

  it("erro sem código Meta: motivo sem código", () => {
    const wahaFail: AttemptRow = { status: "erro", erro_permanente: true, erro: "Sessão WAHA desconectada" };
    const d = decideAutoPause([...Array.from({ length: 30 }, () => wahaFail), ...rows(0, 30)]);
    expect(d.pause).toBe(true);
    if (d.pause) {
      expect(d.topCode).toBeNull();
      expect(d.reason).toMatch(/^Pausada automaticamente: 50% de erro nas últimas 60/);
    }
  });

  it("desligado não pausa", () => {
    expect(decideAutoPause(rows(100, 100), { ...AUTO_PAUSE_DEFAULTS, enabled: false }).pause).toBe(false);
  });
});

describe("autoPauseConfigFromEnv", () => {
  it("defaults", () => {
    expect(autoPauseConfigFromEnv({})).toEqual(AUTO_PAUSE_DEFAULTS);
  });
  it("lê env e ignora valores inválidos", () => {
    expect(
      autoPauseConfigFromEnv({
        DISPARADOR_AUTO_PAUSE_MIN_ATTEMPTS: "20",
        DISPARADOR_AUTO_PAUSE_WINDOW: "200",
        DISPARADOR_AUTO_PAUSE_ERROR_RATE: "0.5",
      })
    ).toEqual({ enabled: true, minAttempts: 20, window: 200, errorRate: 0.5 });
    expect(
      autoPauseConfigFromEnv({ DISPARADOR_AUTO_PAUSE_ERROR_RATE: "30", DISPARADOR_AUTO_PAUSE_WINDOW: "abc" })
    ).toEqual(AUTO_PAUSE_DEFAULTS);
    expect(autoPauseConfigFromEnv({ DISPARADOR_AUTO_PAUSE: "OFF" }).enabled).toBe(false);
  });
  it("mínimo nunca maior que a janela", () => {
    expect(autoPauseConfigFromEnv({ DISPARADOR_AUTO_PAUSE_WINDOW: "30" }).minAttempts).toBe(30);
  });
});
