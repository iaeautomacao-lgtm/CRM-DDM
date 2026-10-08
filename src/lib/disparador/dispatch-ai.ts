import OpenAI from "openai";
import { openAiSdkBaseUrl } from "@/lib/loadtest/gate";

// Geração de texto das campanhas `tipo=ia`. REGRA: se a IA falhar (429, timeout, sem chave ou
// resposta vazia) NADA é enviado — o `mensagem_final` de um item `ia` é o PROMPT de instrução, e
// enviá-lo ao cliente é irreversível. Quem chama devolve o item à fila (ver processQueue.ts).

const DEFAULT_AI_TIMEOUT_MS = 30_000;

function aiTimeoutMs(): number {
  const configured = Number.parseInt(process.env.DISPATCH_OPENAI_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? Math.min(configured, 120_000) : DEFAULT_AI_TIMEOUT_MS;
}

// Um cliente reutilizado por (chave, timeout): antes era `new OpenAI()` por item. maxRetries:0 —
// o retry é do próprio disparador (item volta à fila com backoff), nunca dentro do slot.
let cached: { key: string; timeout: number; client: OpenAI } | null = null;

export function getDispatchOpenAiClient(apiKey: string, timeout = aiTimeoutMs()): OpenAI {
  if (!cached || cached.key !== apiKey || cached.timeout !== timeout) {
    cached = { key: apiKey, timeout, client: new OpenAI({ apiKey, baseURL: openAiSdkBaseUrl(), timeout, maxRetries: 0 }) };
  }
  return cached.client;
}

/** Só para testes. */
export function resetDispatchOpenAiClient(): void {
  cached = null;
}

/** Texto gerado, ou null se a IA não pôde gerar (nunca devolve o prompt). */
export async function generateDispatchAiText(
  prompt: string,
  contactName: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  const apiKey = env.DISPARADOR_OPENAI_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const completion = await getDispatchOpenAiClient(apiKey).chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Você é um assistente de vendas para WhatsApp. Gere uma mensagem natural, sem parecer spam. Responda APENAS com a mensagem, sem explicações.",
        },
        { role: "user", content: `Contato: nome=${contactName || ""}. Prompt: ${prompt}` },
      ],
      max_tokens: 500,
    });
    const text = completion.choices[0]?.message?.content?.trim();
    return text ? text : null;
  } catch (error) {
    console.warn("[dispatch-ai] Geração por IA falhou:", error instanceof Error ? error.message : error);
    return null;
  }
}
