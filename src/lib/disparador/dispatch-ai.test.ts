import { beforeEach, describe, expect, it, vi } from "vitest";

const openai = vi.hoisted(() => ({
  instances: [] as Array<Record<string, unknown>>,
  create: vi.fn(),
}));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: openai.create } };
    constructor(opts: Record<string, unknown>) {
      openai.instances.push(opts);
    }
  },
}));

import { generateDispatchAiText, resetDispatchOpenAiClient } from "./dispatch-ai";

const env = { OPENAI_API_KEY: "sk-test" };

describe("generateDispatchAiText (P0-2 / F1)", () => {
  beforeEach(() => {
    openai.instances.length = 0;
    openai.create.mockReset();
    resetDispatchOpenAiClient();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("devolve o texto gerado; cliente reutilizado e com maxRetries:0", async () => {
    openai.create.mockResolvedValue({ choices: [{ message: { content: " Olá Ana, tudo bem? " } }] });
    expect(await generateDispatchAiText("PROMPT", "Ana", env)).toBe("Olá Ana, tudo bem?");
    expect(await generateDispatchAiText("PROMPT", "Bia", env)).toBe("Olá Ana, tudo bem?");
    expect(openai.instances).toHaveLength(1);
    expect(openai.instances[0]).toMatchObject({ apiKey: "sk-test", maxRetries: 0, timeout: 30_000 });
  });

  it("falha da OpenAI (429/timeout), resposta vazia ou sem chave → null, NUNCA o prompt", async () => {
    openai.create.mockRejectedValueOnce(Object.assign(new Error("429 rate limit"), { status: 429 }));
    expect(await generateDispatchAiText("PROMPT SECRETO", "Ana", env)).toBeNull();
    openai.create.mockResolvedValueOnce({ choices: [{ message: { content: "   " } }] });
    expect(await generateDispatchAiText("PROMPT SECRETO", "Ana", env)).toBeNull();
    openai.create.mockResolvedValueOnce({ choices: [] });
    expect(await generateDispatchAiText("PROMPT SECRETO", "Ana", env)).toBeNull();
    expect(await generateDispatchAiText("PROMPT SECRETO", "Ana", {})).toBeNull();
    expect(openai.create).toHaveBeenCalledTimes(3); // sem chave nem chama
  });
});
