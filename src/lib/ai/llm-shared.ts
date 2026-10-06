import type { SupabaseClient } from "@supabase/supabase-js";
import { tryDecrypt } from "@/lib/whatsapp/encryption";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  getAiModelDefinition,
  isAiProvider,
  resolveAiModel,
} from "@/lib/ai/models";

/**
 * Shared building blocks behind the account's AI analysis pipelines
 * (sentiment, and anything else that needs "read recent messages, ask
 * the account's configured LLM a question, get a short JSON answer back").
 * Extracted from sentiment.ts so new analyses (e.g. auto-tagging) don't
 * duplicate the provider/key resolution and history-fetch logic.
 */

export interface ActiveApiKey {
  provider: string;
  apiKey: string;
  model: string;
}

/**
 * Resolves which LLM provider + API key an account's analyses should run
 * under: the account's own `ai_config.api_key` if set, otherwise the
 * platform's master key for that provider. Returns `null` when there's no
 * AI config for the account, or no key is available either way — callers
 * should treat that as "skip this analysis", not an error.
 */
export async function resolveActiveApiKey(
  db: SupabaseClient,
  accountId: string,
): Promise<ActiveApiKey | null> {
  const { data: aiConfig, error: aiConfigError } = await db
    .from("ai_config")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();

  if (aiConfigError || !aiConfig) {
    return null;
  }

  // ai_config.api_key agora é gravada criptografada (ver migration 084);
  // tryDecrypt cai pro valor bruto se ainda estiver em texto puro (chave
  // salva antes dessa mudança).
  const rawConfigKey = aiConfig.api_key?.trim();
  const configKey = rawConfigKey ? tryDecrypt(rawConfigKey) : rawConfigKey;

  let masterKey = "";
  if (aiConfig.api_provider === "hermes") {
    masterKey = process.env.OPENROUTER_API_KEY || "";
  } else if (aiConfig.api_provider === "openai") {
    masterKey = process.env.OPENAI_API_KEY || "";
  } else if (aiConfig.api_provider === "claude") {
    masterKey = process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  } else if (aiConfig.api_provider === "gemini") {
    masterKey = process.env.GEMINI_API_KEY || "";
  }

  const activeKey = !configKey ? masterKey : configKey;
  if (!activeKey || !isAiProvider(aiConfig.api_provider)) return null;

  const resolvedModel = resolveAiModel({
    provider: aiConfig.api_provider,
    accountModel:
      typeof (aiConfig as { api_model?: unknown }).api_model === "string"
        ? (aiConfig as { api_model: string }).api_model
        : null,
  });
  if (!resolvedModel) return null;

  return {
    provider: aiConfig.api_provider,
    apiKey: activeKey,
    model: resolvedModel.model,
  };
}

/**
 * Loads the last `limit` messages of a conversation, oldest first, and
 * formats them as "Cliente:"/"Atendente:" lines for an LLM prompt. Returns
 * `null` when there's no history to analyze yet.
 */
export async function fetchRecentHistoryText(
  db: SupabaseClient,
  conversationId: string,
  limit = 15,
): Promise<string | null> {
  const { data: messages, error: messagesError } = await db
    .from("messages")
    .select("content_text, created_at, sender_type")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (messagesError || !messages || messages.length === 0) {
    return null;
  }

  const history = messages.reverse();

  return history
    .map((m) => {
      const role = m.sender_type === "customer" ? "Cliente" : "Atendente";
      return `${role}: ${m.content_text || ""}`;
    })
    .join("\n");
}

/** Strips a ```json ... ``` (or bare ```) code fence some providers wrap responses in. */
export function stripJsonFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();
}

/**
 * Sends `prompt` to the given provider's chat/completion endpoint and
 * returns the raw text response (expected to be a JSON string per the
 * caller's own prompt instructions — parsing is the caller's job).
 */
export async function callLlmForAnalysis(
  provider: string,
  apiKey: string,
  prompt: string,
  model?: string,
): Promise<string> {
  const effectiveModel =
    model ||
    (isAiProvider(provider) ? DEFAULT_MODEL_BY_PROVIDER[provider] : null);
  if (!effectiveModel) {
    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  if (provider === "openai") {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: effectiveModel,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        response_format: { type: "json_object" },
        ...(getAiModelDefinition("openai", effectiveModel)?.openai_chat
          ?.reasoning_effort
          ? {
              reasoning_effort: getAiModelDefinition("openai", effectiveModel)!
                .openai_chat!.reasoning_effort,
            }
          : {}),
      }),
    });
    if (!response.ok) throw new Error(`OpenAI error: ${response.status}`);
    const data = await response.json();
    return data?.choices?.[0]?.message?.content || "";
  } else if (provider === "claude") {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: effectiveModel,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`Claude error: ${response.status}`);
    const data = await response.json();
    const textBlock = Array.isArray(data?.content)
      ? data.content.find((block: { type?: string; text?: string }) => block?.type === "text")
      : null;
    return textBlock?.text || "";
  } else if (provider === "hermes") {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://wacrm.vercel.app",
        "X-Title": "WA CRM",
      },
      body: JSON.stringify({
        model: effectiveModel,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) throw new Error(`Hermes error: ${response.status}`);
    const data = await response.json();
    return data?.choices?.[0]?.message?.content || "";
  } else {
    // Gemini
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${effectiveModel}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: 500,
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    });
    if (!response.ok) throw new Error(`Gemini error: ${response.status}`);
    const data = await response.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }
}
