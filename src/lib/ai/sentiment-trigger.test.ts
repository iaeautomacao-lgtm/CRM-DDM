import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const analyze = vi.fn(async () => {});
vi.mock("./sentiment", () => ({ analyzeConversationSentimentAndTags: analyze }));

import { scheduleSentimentAnalysis, shouldAnalyzeSentiment } from "./sentiment-trigger";

describe("shouldAnalyzeSentiment", () => {
  it("sem fluxo, qualquer texto conta", () => {
    expect(shouldAnalyzeSentiment({ text: "1", flowConsumed: false })).toBe(true);
    expect(shouldAnalyzeSentiment({ text: "ok", flowConsumed: false })).toBe(true);
  });

  it("vazio nunca", () => {
    expect(shouldAnalyzeSentiment({ text: "  ", flowConsumed: false })).toBe(false);
    expect(shouldAnalyzeSentiment({ text: null, flowConsumed: false })).toBe(false);
  });

  it("com fluxo, ignora menu e botões", () => {
    expect(shouldAnalyzeSentiment({ text: "2", flowConsumed: true })).toBe(false);
    expect(shouldAnalyzeSentiment({ text: "3.", flowConsumed: true })).toBe(false);
    expect(shouldAnalyzeSentiment({ text: "Sim", flowConsumed: true })).toBe(false);
    expect(
      shouldAnalyzeSentiment({ text: "Quero negociar minha dívida", flowConsumed: true, isInteractiveReply: true }),
    ).toBe(false);
  });

  it("marcadores de tipo não vão à IA", () => {
    expect(shouldAnalyzeSentiment({ text: "[Unsupported message type: button]", flowConsumed: true })).toBe(false);
    expect(shouldAnalyzeSentiment({ text: "[image]", flowConsumed: false })).toBe(false);
  });

  it("com fluxo, analisa texto de conversa", () => {
    expect(shouldAnalyzeSentiment({ text: "isso é um absurdo", flowConsumed: true })).toBe(true);
    expect(shouldAnalyzeSentiment({ text: "péssimoatendimento", flowConsumed: true })).toBe(true);
  });
});

describe("scheduleSentimentAnalysis", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    analyze.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("roda uma vez por rajada, depois da espera", async () => {
    scheduleSentimentAnalysis("a", "c", "conv-1", 1000);
    await vi.advanceTimersByTimeAsync(500);
    scheduleSentimentAnalysis("a", "c", "conv-1", 1000);
    await vi.advanceTimersByTimeAsync(900);
    expect(analyze).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(1));
    expect(analyze).toHaveBeenCalledWith("a", "c", "conv-1");
  });

  it("conversas diferentes não se cancelam", async () => {
    scheduleSentimentAnalysis("a", "c1", "conv-a", 1000);
    scheduleSentimentAnalysis("a", "c2", "conv-b", 1000);
    await vi.advanceTimersByTimeAsync(1100);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
  });
});
