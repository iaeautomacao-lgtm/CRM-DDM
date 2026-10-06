// Cliente OpenAI (pacote `openai`, como em disparador/processQueue.ts) para
// o laço do chat. Usa streaming: o texto sai em pedaços pelo onTextDelta e
// as chamadas de ferramenta são remontadas a partir dos deltas.

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { ChatLlmClient, LlmCompletion, LlmCompletionRequest, LlmMessage, LlmToolCall } from "./types";

export const DEFAULT_INTELLIGENCE_MODEL = "gpt-4o-mini";

/** Modelo do chat: env INTELLIGENCE_MODEL (vazio → padrão). */
export function intelligenceModel(env: Record<string, string | undefined> = process.env): string {
  const configured = env.INTELLIGENCE_MODEL?.trim();
  return configured ? configured : DEFAULT_INTELLIGENCE_MODEL;
}

function toOpenAiMessage(m: LlmMessage): ChatCompletionMessageParam {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return { role: "user", content: m.content };
    case "tool":
      return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(m.tool_calls?.length
          ? {
              tool_calls: m.tool_calls.map((c) => ({
                id: c.id,
                type: "function" as const,
                function: { name: c.name, arguments: c.arguments },
              })),
            }
          : {}),
      };
  }
}

export interface OpenAiChatClientOptions {
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxTokens?: number;
}

export function createOpenAiChatClient(opts: OpenAiChatClientOptions): ChatLlmClient {
  const client = new OpenAI({ apiKey: opts.apiKey, timeout: opts.timeoutMs ?? 60_000, maxRetries: 1 });

  return {
    async complete(req: LlmCompletionRequest): Promise<LlmCompletion> {
      const tools: ChatCompletionTool[] | undefined = req.tools?.length
        ? req.tools.map((t) => ({
            type: "function" as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters as unknown as Record<string, unknown>,
            },
          }))
        : undefined;

      const stream = await client.chat.completions.create({
        model: opts.model,
        messages: req.messages.map(toOpenAiMessage),
        ...(tools ? { tools, tool_choice: "auto" as const } : {}),
        temperature: 0.1,
        max_tokens: opts.maxTokens ?? 1_500,
        stream: true,
      });

      let content = "";
      const calls = new Map<number, LlmToolCall>();
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          req.onTextDelta?.(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const current = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
          if (tc.id) current.id = tc.id;
          if (tc.function?.name) current.name += tc.function.name;
          if (tc.function?.arguments) current.arguments += tc.function.arguments;
          calls.set(tc.index, current);
        }
      }

      const toolCalls = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, c]) => ({ ...c, id: c.id || `call_${index}` }))
        .filter((c) => c.name);
      return { content, toolCalls };
    },
  };
}
