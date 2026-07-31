import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveActiveApiKey, fetchRecentHistoryText, callLlmForAnalysis, stripJsonFences } from "./llm-shared";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Cast needed because the `wacrm` schema option narrows the client's
// generic SchemaName away from the default "public" — same pattern as
// src/lib/automations/admin-client.ts.
const supabaseAdmin = () => createClient(supabaseUrl, supabaseServiceKey, {
  db: {
    schema: 'wacrm'
  }
}) as unknown as SupabaseClient;

export async function analyzeConversationSentimentAndTags(
  accountId: string,
  contactId: string,
  conversationId: string
) {
  const db = supabaseAdmin();

  // 1. Resolve provider + API key (account's own key, or the platform's
  // master key for that provider)
  const activeConfig = await resolveActiveApiKey(db, accountId);
  if (!activeConfig) return;
  const { provider, apiKey: activeKey } = activeConfig;

  // 2. Fetch existing tags for the account
  const { data: existingTags, error: tagsErr } = await db
    .from("tags")
    .select("id, name")
    .eq("account_id", accountId);

  const tagsList = existingTags || [];

  // 3. Load recent conversation history (last 15 messages)
  const historyText = await fetchRecentHistoryText(db, conversationId);
  if (!historyText) return;

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
    const rawResult = await callLlmForAnalysis(provider, activeKey, prompt);

    const cleanJson = stripJsonFences(rawResult);

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
