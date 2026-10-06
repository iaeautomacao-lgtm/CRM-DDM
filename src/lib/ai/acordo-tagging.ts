import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { auditFetch } from '@/lib/audit/context'
import { resolveActiveApiKey, fetchRecentHistoryText, callLlmForAnalysis, stripJsonFences } from "./llm-shared";
import { latestMessageKey, type LlmCaller } from "./tabulacao-suggest";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Cast needed because the `wacrm` schema option narrows the client's
// generic SchemaName away from the default "public" — same pattern as
// src/lib/automations/admin-client.ts and src/lib/ai/sentiment.ts.
const supabaseAdmin = () => createClient(supabaseUrl, supabaseServiceKey, {
  db: {
    schema: 'wacrm'
  },
        // Auditoria (migration 131): escritas da IA saem como ator "ai".
        global: { fetch: auditFetch, headers: { 'x-audit-actor-type': 'ai', 'x-audit-source': 'ia' } },
}) as unknown as SupabaseClient;

/** codigo_tabulacao of the "Acordo Realizado" outcome tag, seeded per
 *  account by wacrm.seed_tabulacao_tags() (migration 041). */
export const ACORDO_REALIZADO_CODIGO = 142;

/** Confiança gravada na sugestão: o classificador é conservador por
 *  construção (só diz "true" com confirmação explícita). */
export const ACORDO_SUGGESTION_CONFIDENCE = 0.9;

export const ACORDO_SUGGESTION_REASON =
  "Acordo de pagamento formalizado detectado pela IA na conversa";

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
 * — production callers pass `(prompt) => callLlmForAnalysis(provider, apiKey, prompt, model)`.
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

export type AcordoSuggestionResult =
  | "skipped"
  | "flow_in_charge"
  | "already_analyzed"
  | "no_ai"
  | "not_formalized"
  | "no_tag"
  | "suggested";

interface AcordoConversationRow {
  id: string;
  status: string;
  outcome_tag_id: string | null;
  outcome_suggestion_source: string | null;
  outcome_suggestion_key: string | null;
}

/**
 * Classificador "Acordo Realizado" para conversas FORA de fluxo (as
 * conduzidas por fluxo sugerem pela tag de saída da IA — ver
 * outcome-suggestion.ts). Chamado com debounce pelos webhooks
 * (acordo-trigger.ts), não a cada mensagem.
 *
 * Antes gravava outcome_tag_id em silêncio; agora grava uma SUGESTÃO
 * (suggested_outcome_tag_id, source 'llm') que o atendente confirma no
 * picker. Usa o provider + modelo + chave da conta. Cache por última
 * mensagem (outcome_suggestion_key): a mesma mensagem nunca é analisada
 * duas vezes. Nunca lança.
 */
export async function suggestAcordoRealizado(
  accountId: string,
  conversationId: string,
  deps: { db?: SupabaseClient; callLlm?: LlmCaller } = {},
): Promise<AcordoSuggestionResult> {
  try {
    const db = deps.db ?? supabaseAdmin();

    const { data: conversation, error: convError } = await db
      .from("conversations")
      .select("id, status, outcome_tag_id, outcome_suggestion_source, outcome_suggestion_key")
      .eq("id", conversationId)
      .eq("account_id", accountId)
      .maybeSingle();
    const conv = conversation as AcordoConversationRow | null;

    // Já tabulada/fechada: nada a sugerir.
    if (convError || !conv || conv.status === "closed" || conv.outcome_tag_id) {
      return "skipped";
    }
    // Fluxo no comando: a sugestão vem da tag de saída da IA.
    if (conv.outcome_suggestion_source === "exit_tag") return "flow_in_charge";
    const { data: activeRuns } = await db
      .from("flow_runs")
      .select("id")
      .eq("conversation_id", conversationId)
      .eq("status", "active")
      .limit(1);
    if (activeRuns && activeRuns.length > 0) return "flow_in_charge";

    const key = await latestMessageKey(db, conversationId);
    if (!key) return "skipped";
    if (conv.outcome_suggestion_key === key) return "already_analyzed";

    const activeConfig = await resolveActiveApiKey(db, accountId);
    if (!activeConfig) return "no_ai";
    const { provider, apiKey, model } = activeConfig;

    const historyText = await fetchRecentHistoryText(db, conversationId);
    if (!historyText) return "skipped";

    const callLlm = deps.callLlm ?? callLlmForAnalysis;
    const isFormalized = await classifyAcordoFormalizado(historyText, (prompt) =>
      callLlm(provider, apiKey, prompt, model),
    );
    if (!isFormalized) return "not_formalized";

    // Multi-tenant: resolve "Acordo Realizado" for THIS account, never a
    // fixed id.
    const { data: tags, error: tagError } = await db
      .from("tags")
      .select("id")
      .eq("account_id", accountId)
      .eq("kind", "outcome")
      .eq("codigo_tabulacao", ACORDO_REALIZADO_CODIGO)
      .limit(1);
    const tag = (tags as { id: string }[] | null)?.[0];

    if (tagError || !tag) {
      console.error(
        `[Acordo Tagging] outcome tag codigo_tabulacao=${ACORDO_REALIZADO_CODIGO} not found for account`,
        accountId,
        tagError,
      );
      return "no_tag";
    }

    // Guardas na própria escrita (não só na leitura acima): conversa
    // fechada/tabulada ou sugestão do fluxo entre a leitura e a escrita
    // não são tocadas.
    const { error: updateError } = await db
      .from("conversations")
      .update({
        suggested_outcome_tag_id: tag.id,
        outcome_suggestion_source: "llm",
        outcome_suggestion_confidence: ACORDO_SUGGESTION_CONFIDENCE,
        outcome_suggestion_reason: ACORDO_SUGGESTION_REASON,
        outcome_suggested_at: new Date().toISOString(),
        outcome_suggestion_key: key,
      })
      .eq("id", conversationId)
      .eq("account_id", accountId)
      .neq("status", "closed")
      .is("outcome_tag_id", null)
      .or("outcome_suggestion_source.is.null,outcome_suggestion_source.neq.exit_tag");
    if (updateError) {
      console.error("[Acordo Tagging] suggestion write failed:", updateError.message);
      return "skipped";
    }
    return "suggested";
  } catch (err) {
    console.error("[Acordo Tagging] Error:", err);
    return "skipped";
  }
}
