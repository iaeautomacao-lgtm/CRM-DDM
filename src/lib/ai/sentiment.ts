import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabaseAdmin = () => createClient(supabaseUrl, supabaseServiceKey, {
  db: {
    schema: 'wacrm'
  }
});

export async function analyzeConversationSentimentAndTags(
  accountId: string,
  contactId: string,
  conversationId: string
) {
  const db = supabaseAdmin();

  // 1. Fetch AI Configuration (use key even if chatbot is disabled)
  const { data: aiConfig, error: aiConfigError } = await db
    .from("ai_config")
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();

  if (aiConfigError || !aiConfig) {
    return; // No AI configuration
  }

  const configKey = aiConfig.api_key?.trim();

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

  if (!activeKey) {
    return; // No active API key found
  }

  // 2. Fetch existing tags for the account
  const { data: existingTags, error: tagsErr } = await db
    .from("tags")
    .select("id, name")
    .eq("account_id", accountId);

  const tagsList = existingTags || [];

  // 3. Load recent conversation history (last 15 messages)
  const { data: messages, error: messagesError } = await db
    .from("messages")
    .select("content_text, created_at, sender_type")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(15);

  if (messagesError || !messages || messages.length === 0) {
    return;
  }

  // Chronological order
  const history = messages.reverse();

  // Format history text for the LLM
  const historyText = history
    .map((m) => {
      const role = m.sender_type === "customer" ? "Cliente" : "Atendente";
      return `${role}: ${m.content_text || ""}`;
    })
    .join("\n");

  const prompt = `Você é um analista de CRM inteligente para WhatsApp. Analise o histórico da conversa abaixo e extraia:
1. O sentimento predominante do cliente (positive, neutral, negative ou mixed).

Sua resposta deve ser um objeto JSON válido, sem qualquer texto explicativo antes ou depois, sem aspas de bloco de código (\`\`\`), contendo a seguinte estrutura:
{
  "sentiment": "positive" | "neutral" | "negative" | "mixed"
}

Histórico da Conversa:
"""
${historyText}
"""`;

  try {
    const rawResult = await callLlmForAnalysis(
      aiConfig.api_provider,
      activeKey,
      prompt
    );

    const cleanJson = rawResult
      .trim()
      .replace(/^```json/i, "")
      .replace(/^```/, "")
      .replace(/```$/, "")
      .trim();

    const data = JSON.parse(cleanJson);
    const sentiment = data.sentiment;

    // Update conversation sentiment
    if (["positive", "neutral", "negative", "mixed"].includes(sentiment)) {
      await db
        .from("conversations")
        .update({ sentiment })
        .eq("id", conversationId);
    }
  } catch (err) {
    console.error("[Sentiment & Tags Analysis] Error processing LLM response:", err);
  }
}

async function callLlmForAnalysis(
  provider: string,
  apiKey: string,
  prompt: string
): Promise<string> {
  if (provider === "openai") {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        response_format: { type: "json_object" },
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
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!response.ok) throw new Error(`Claude error: ${response.status}`);
    const data = await response.json();
    return data?.content?.[0]?.text || "";
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
        model: "nousresearch/hermes-3-llama-3.1-405b",
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
    const model = "gemini-1.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
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
