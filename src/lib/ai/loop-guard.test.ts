import { describe, expect, it } from "vitest";
import { BOT_LOOP_MIN_MESSAGES, BOT_LOOP_WINDOW_SECONDS, detectBotLoop } from "./loop-guard";

const now = new Date("2026-10-06T12:00:00Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();

describe("detectBotLoop", () => {
  it("bot respondendo a outro robô a cada ~10 s dispara", () => {
    const bot = Array.from({ length: BOT_LOOP_MIN_MESSAGES }, (_, i) => ago(i * 10));
    expect(detectBotLoop(bot, now)).toEqual({
      botMessages: BOT_LOOP_MIN_MESSAGES,
      windowSeconds: (BOT_LOOP_MIN_MESSAGES - 1) * 10,
    });
  });

  it("cliente mandando várias fotos seguidas não dispara (só conta o bot)", () => {
    // A função só recebe mensagens do bot: 10 fotos do cliente em 5 s não
    // entram; o bot respondeu 2 vezes.
    expect(detectBotLoop([ago(3), ago(40)], now)).toBeNull();
  });

  it("conversa humana normal (bot responde algumas vezes por minuto) não dispara", () => {
    const bot = [ago(5), ago(6), ago(30), ago(55), ago(80), ago(100), ago(118)];
    expect(bot.length).toBeLessThan(BOT_LOOP_MIN_MESSAGES);
    expect(detectBotLoop(bot, now)).toBeNull();
  });

  it("mensagens fora da janela não contam", () => {
    const bot = Array.from({ length: BOT_LOOP_MIN_MESSAGES }, (_, i) => ago(BOT_LOOP_WINDOW_SECONDS + 1 + i));
    expect(detectBotLoop(bot, now)).toBeNull();
  });

  it("ignora horários inválidos", () => {
    expect(detectBotLoop([null, undefined, "x"], now)).toBeNull();
  });
});
