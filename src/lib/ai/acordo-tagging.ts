import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveActiveApiKey, fetchRecentHistoryText, callLlmForAnalysis, stripJsonFences } from "./llm-shared";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Cast needed because the `wacrm` schema option narrows the client's
// generic SchemaName away from the default "public" — same pattern as
// src/lib/automations/admin-client.ts and src/lib/ai/sentiment.ts.
const supabaseAdmin = () => createClient(supabaseUrl, supabaseServiceKey, {
  db: {
    schema: 'wacrm'
  }
}) as unknown as SupabaseClient;

/** codigo_tabulacao of the "Acordo Realizado" outcome tag, seeded per
 *  account by wacrm.seed_tabulacao_tags() (migration 041). */
export const ACORDO_REALIZADO_CODIGO = 142;

export function buildAcordoPrompt(historyText: string): string {
  return `Você é um analista de cobrança para WhatsApp. Analise o histórico da conversa abaixo e responda apenas UMA pergunta: esta conversa resultou em um acordo de pagamento FORMALIZADO e FECHADO com o cliente?

Marque "true" SOMENTE se houver confirmação clara e inequívoca de acordo fechado — por exemplo: valor e condição de pagamento foram acordados E o cliente confirmou explicitamente que aceita (ex: "fechado", "pode gerar o boleto", "aceito", "combinado").

Marque "false" em QUALQUER outro caso, incluindo quando:
- o cliente só demonstrou interesse ou está pensando a respeito;
- a negociação ainda está em andamento (valores sendo discutidos, sem confirmação final);
- a conversa é ambígua, incompleta, ou não há confirmação explícita do cliente;
- você não tem certeza.

Na dúvida, responda SEMPRE "false". Marcar um acordo que não existe é pior do que deixar de marcar um acordo real — isso é dado de régua de cobrança.

Sua resposta deve ser um objeto JSON válido, sem qualquer texto explicativo antes ou depois, sem aspas de bloco de código (\`\`\`), contendo a seguinte estrutura:
{
  "acordo_formalizado": true | false
}

Histórico da Conversa:
"""
${historyText}
"""`;
}

/**
 * Parses the LLM's raw response into a strict boolean. Any parse error,
 * missing field, or non-boolean value defaults to `false` — conservative
 * by construction, per the "never propagates, never guesses true" contract
 * this feature requires (this is billing-adjacent data).
 */
export function parseAcordoResponse(raw: string): boolean {
  try {
    const clean = stripJsonFences(raw);
    const data = JSON.parse(clean);
    return data?.acordo_formalizado === true;
  } catch {
    return false;
  }
}

/**
 * Classifies a conversation's history as "formalized agreement" or not.
 * `callLlm` is injected so this can be unit-tested without a real LLM call
 * — production callers pass `(prompt) => callLlmForAnalysis(provider, apiKey, prompt)`.
 */
export async function classifyAcordoFormalizado(
  historyText: string,
  callLlm: (prompt: string) => Promise<string>,
): Promise<boolean> {
  try {
    const raw = await callLlm(buildAcordoPrompt(historyText));
    return parseAcordoResponse(raw);
  } catch (err) {
    console.error("[Acordo Tagging] LLM call failed:", err);
    return false;
  }
}

/**
 * Fire-and-forget entry point, called from the WhatsApp webhooks on every
 * inbound message — same shape as analyzeConversationSentimentAndTags.
 *
 * Silently tags the conversation with the account's "Acordo Realizado"
 * outcome tag when the AI is confident a payment agreement was closed.
 * Never closes the conversation (a human does that) and never throws.
 */
export async function autoTagAcordoRealizado(
  accountId: string,
  contactId: string,
  conversationId: string,
) {
  try {
    const db = supabaseAdmin();

    // Cost guard: a conversation only ever gets classified once. Once
    // outcome_tag_id is set (by this, by a human, or by an automation),
    // never reprocess it.
    const { data: conversation, error: convError } = await db
      .from("conversations")
      .select("outcome_tag_id")
      .eq("id", conversationId)
      .maybeSingle();

    if (convError || !conversation || conversation.outcome_tag_id) {
      return;
    }

    const activeConfig = await resolveActiveApiKey(db, accountId);
    if (!activeConfig) return;
    const { provider, apiKey } = activeConfig;

    const historyText = await fetchRecentHistoryText(db, conversationId);
    if (!historyText) return;

    const isFormalized = await classifyAcordoFormalizado(historyText, (prompt) =>
      callLlmForAnalysis(provider, apiKey, prompt),
    );
    if (!isFormalized) return;

    // Multi-tenant: resolve "Acordo Realizado" for THIS account, never a
    // fixed id — mirrors the fallback-tag lookup in
    // src/lib/automations/engine.ts (close_conversation step).
    const { data: tag, error: tagError } = await db
      .from("tags")
      .select("id")
      .eq("account_id", accountId)
      .eq("kind", "outcome")
      .eq("codigo_tabulacao", ACORDO_REALIZADO_CODIGO)
      .maybeSingle();

    if (tagError || !tag) {
      console.error(
        `[Acordo Tagging] outcome tag codigo_tabulacao=${ACORDO_REALIZADO_CODIGO} not found for account`,
        accountId,
        tagError,
      );
      return;
    }

    // `outcome_tag_id IS NULL` on the write itself (not just the read
    // above) closes the race between two near-simultaneous inbound
    // messages both passing the guard read before either writes.
    await db
      .from("conversations")
      .update({ outcome_tag_id: tag.id })
      .eq("id", conversationId)
      .is("outcome_tag_id", null);
  } catch (err) {
    console.error("[Acordo Tagging] Error:", err);
  }
}
