import { afterEach, describe, expect, it, vi } from "vitest";
import { recordAiTokenUsage, tokensFromProviderResponse } from "./usage";

type Upsert = { row: Record<string, unknown>; opts: unknown };
function fakeDb(error: { code?: string } | null = null, throws = false) {
  const calls: Upsert[] = [];
  const db = {
    from: (table: string) => ({
      upsert: async (row: Record<string, unknown>, opts: unknown) => {
        if (throws) throw new Error("boom");
        calls.push({ row: { ...row, __table: table }, opts });
        return { error };
      },
    }),
  };
  return { db: db as never, calls };
}

afterEach(() => vi.restoreAllMocks());

describe("tokensFromProviderResponse", () => {
  it("openai/hermes: prompt, completion e cache", () => {
    expect(tokensFromProviderResponse("openai", { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } })).toEqual({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 });
    expect(tokensFromProviderResponse("hermes", { usage: { prompt_tokens: 5, completion_tokens: 1 } })).toEqual({ inputTokens: 5, outputTokens: 1, cachedInputTokens: 0 });
  });
  it("claude: soma leitura e criação de cache à entrada", () => {
    expect(tokensFromProviderResponse("claude", { usage: { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 5, output_tokens: 7 } })).toEqual({ inputTokens: 45, outputTokens: 7, cachedInputTokens: 30 });
  });
  it("gemini: usageMetadata (saída inclui pensamento)", () => {
    expect(tokensFromProviderResponse("gemini", { usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 8, thoughtsTokenCount: 2, cachedContentTokenCount: 80 } })).toEqual({ inputTokens: 50, outputTokens: 10, cachedInputTokens: 50 });
  });
  it("sem uso informado = null (não vira zero)", () => {
    expect(tokensFromProviderResponse("openai", {})).toBeNull();
    expect(tokensFromProviderResponse("gemini", { usage: {} })).toBeNull();
    expect(tokensFromProviderResponse("claude", null)).toBeNull();
  });
});

describe("recordAiTokenUsage", () => {
  const response = { id: "chatcmpl-1", choices: [{ message: { content: "texto secreto do cliente 123.456.789-00" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  const base = { accountId: "acc", provider: "openai", model: "m", feature: "f", response };

  it("grava só contagens e metadados — nada de texto da conversa", async () => {
    const { db, calls } = fakeDb();
    await recordAiTokenUsage({ ...base, model: "gpt-4o-mini", feature: "responder" }, db);
    expect(calls).toHaveLength(1);
    expect(calls[0].row).toEqual({ __table: "ai_token_usage", account_id: "acc", request_id: "chatcmpl-1", provider: "openai", model: "gpt-4o-mini", feature: "responder", input_tokens: 10, output_tokens: 2, cached_input_tokens: 0 });
    expect(JSON.stringify(calls)).not.toMatch(/secreto|123\.456/);
    expect(calls[0].opts).toMatchObject({ onConflict: "account_id,provider,request_id", ignoreDuplicates: true });
  });
  it("sem conta ou sem uso informado: não grava", async () => {
    const { db, calls } = fakeDb();
    await recordAiTokenUsage({ ...base, accountId: null }, db);
    await recordAiTokenUsage({ ...base, response: { id: "x" } }, db);
    expect(calls).toHaveLength(0);
  });
  it("nunca lança: erro do banco, exceção e tabela ausente (sem ruído)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(recordAiTokenUsage(base, fakeDb({ code: "XX000" }).db)).resolves.toBeUndefined();
    await expect(recordAiTokenUsage(base, fakeDb(null, true).db)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(2);
    for (const call of err.mock.calls) expect(JSON.stringify(call)).not.toMatch(/secreto/);
    err.mockClear();
    await recordAiTokenUsage(base, fakeDb({ code: "42P01" }).db);
    expect(err).not.toHaveBeenCalled();
  });
  it("limita o tamanho dos campos de texto", async () => {
    const { db, calls } = fakeDb();
    await recordAiTokenUsage({ ...base, model: "m".repeat(300), feature: "f".repeat(300), response: { ...response, id: "i".repeat(500) } }, db);
    expect((calls[0].row.model as string).length).toBe(128);
    expect((calls[0].row.feature as string).length).toBe(80);
    expect((calls[0].row.request_id as string).length).toBe(200);
  });
});
