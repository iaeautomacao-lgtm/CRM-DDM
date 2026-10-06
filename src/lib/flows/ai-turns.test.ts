import { describe, expect, it } from "vitest";
import {
  MAX_FREE_AI_TURNS,
  isTurnFreeInbound,
  nextAiTurnCount,
  parkBeforeAiAgent,
  readTurnVar,
} from "./ai-turns";

describe("isTurnFreeInbound", () => {
  it("mídia sem texto não conta (exceto áudio, que é transcrito)", () => {
    expect(isTurnFreeInbound("", "image")).toBe(true);
    expect(isTurnFreeInbound(null, "sticker")).toBe(true);
    expect(isTurnFreeInbound("  ", "document")).toBe(true);
    expect(isTurnFreeInbound("", "video")).toBe(true);
    expect(isTurnFreeInbound("", "audio")).toBe(false);
    expect(isTurnFreeInbound("", "text")).toBe(false);
    expect(isTurnFreeInbound("", null)).toBe(false);
  });

  it("confirmação pura não conta", () => {
    for (const t of ["ok", "OK!", "Ok ok", "okay", "👍", "👍🏻", "🙏🙏", "obrigado", "Obrigada!", "muito obrigado", "ok, obrigado 👍"]) {
      expect(isTurnFreeInbound(t, "text"), t).toBe(true);
    }
  });

  it("respostas que podem ser decisão contam (conservador)", () => {
    for (const t of ["sim", "certo", "blz", "beleza", "não", "ok pode ser", "3x", "muito", "!!", "ok quero o boleto"]) {
      expect(isTurnFreeInbound(t, "text"), t).toBe(false);
    }
  });

  it("legenda na foto conta como texto", () => {
    expect(isTurnFreeInbound("segue o comprovante", "image")).toBe(false);
  });
});

describe("nextAiTurnCount", () => {
  it("turno normal soma 1", () => {
    expect(nextAiTurnCount(2, 0, false)).toEqual({ turns: 3, freeTurns: 0, free: false });
  });

  it("turno isento não soma, até o limite de turnos grátis", () => {
    let turns = 0;
    let free = 0;
    for (let i = 0; i < MAX_FREE_AI_TURNS; i++) {
      const r = nextAiTurnCount(turns, free, true);
      expect(r.free).toBe(true);
      turns = r.turns;
      free = r.freeTurns;
    }
    expect(turns).toBe(0);
    // Esgotou os grátis: volta a contar (cliente mandando só figurinha não
    // segura o nó para sempre).
    expect(nextAiTurnCount(turns, free, true)).toEqual({ turns: 1, freeTurns: MAX_FREE_AI_TURNS, free: false });
  });

  it("readTurnVar tolera ausência/lixo", () => {
    expect(readTurnVar({ __ai_turns__: 2 }, "__ai_turns__")).toBe(2);
    expect(readTurnVar({ __ai_turns__: "2" }, "__ai_turns__")).toBe(0);
    expect(readTurnVar(undefined, "__ai_turns__")).toBe(0);
  });
});

describe("parkBeforeAiAgent", () => {
  it("estaciona no ai_agent em loop quando a IA já respondeu à mensagem neste walk", () => {
    expect(parkBeforeAiAgent({ mode: "loop" }, { inboundAnsweredByAi: true })).toBe(true);
  });

  it("roda na hora quando nenhuma IA respondeu (trigger, BEN só com #NEGOCIACAO)", () => {
    expect(parkBeforeAiAgent({ mode: "loop" }, {})).toBe(false);
    expect(parkBeforeAiAgent({ mode: "loop" }, undefined)).toBe(false);
    expect(parkBeforeAiAgent({ mode: "loop" }, { inboundAnsweredByAi: false })).toBe(false);
  });

  it("once/takeover não estacionam (não ficam parados em si mesmos)", () => {
    expect(parkBeforeAiAgent({ mode: "once" }, { inboundAnsweredByAi: true })).toBe(false);
    expect(parkBeforeAiAgent({ mode: "takeover" }, { inboundAnsweredByAi: true })).toBe(false);
  });
});
