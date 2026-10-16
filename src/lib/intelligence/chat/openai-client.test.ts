import { beforeEach, describe, expect, it, vi } from "vitest";

const openai = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: openai.create } };
  },
}));

import { createOpenAiChatClient } from "./openai-client";

async function* chunks(list: unknown[]) {
  for (const c of list) yield c;
}
const textChunks = [
  { choices: [{ delta: { content: "Olá" } }] },
  { choices: [{ delta: { content: ", tudo bem?" } }] },
  { choices: [], usage: { prompt_tokens: 30, completion_tokens: 4 } }, // chunk final de uso (include_usage)
];
const req = { messages: [{ role: "user" as const, content: "oi" }] } as never;

beforeEach(() => openai.create.mockReset());

describe("createOpenAiChatClient — uso de tokens (custo de IA, 378)", () => {
  it("pede o chunk de uso e entrega só ele ao onUsage; o texto da resposta não muda", async () => {
    openai.create.mockResolvedValue(chunks(textChunks));
    const onUsage = vi.fn();
    const out = await createOpenAiChatClient({ apiKey: "k", model: "gpt-4o-mini", onUsage }).complete(req);
    expect(out.content).toBe("Olá, tudo bem?");
    expect(openai.create.mock.calls[0][0]).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0]).toMatchObject({ usage: { prompt_tokens: 30, completion_tokens: 4 } });
  });
  it("sem uso no stream, não chama o onUsage; sem onUsage, funciona igual", async () => {
    openai.create.mockResolvedValue(chunks(textChunks.slice(0, 2)));
    const onUsage = vi.fn();
    await createOpenAiChatClient({ apiKey: "k", model: "m", onUsage }).complete(req);
    expect(onUsage).not.toHaveBeenCalled();
    openai.create.mockResolvedValue(chunks(textChunks));
    expect((await createOpenAiChatClient({ apiKey: "k", model: "m" }).complete(req)).content).toBe("Olá, tudo bem?");
  });
  it("onUsage que lança não derruba a resposta", async () => {
    openai.create.mockResolvedValue(chunks(textChunks));
    const out = await createOpenAiChatClient({ apiKey: "k", model: "m", onUsage: () => { throw new Error("boom"); } }).complete(req);
    expect(out.content).toBe("Olá, tudo bem?");
  });
});
