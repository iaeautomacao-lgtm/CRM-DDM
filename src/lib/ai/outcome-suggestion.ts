import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeExitTag } from "./exit-tags";

/**
 * Tag de saída da IA → SUGESTÃO de tabulação (migration 157).
 *
 * Quando o agente de IA de um fluxo fecha a resposta com uma tag de saída
 * (#ACORDOFORMALIZADO, #RECUSA_CONFIRMADA…), o motor registra a decisão em
 * ai_decisions (logAiDecision em flows/engine.ts). Daqui sai a sugestão:
 *   - wacrm.ai_exit_tag_outcome_map (por conta) diz qual tabulação a tag
 *     sugere; sem linha no mapa, nada acontece;
 *   - grava suggested_outcome_tag_id com source 'exit_tag', confiança 1 e
 *     motivo = tag (+ motivo do handoff, quando houver);
 *   - NUNCA mexe numa tabulação humana (outcome_source = 'human') nem em
 *     conversa fechada;
 *   - auto_close (default false — DECISÃO DE PRODUTO PENDENTE): só com a
 *     linha do mapa marcada, fecha a conversa com a tabulação
 *     (outcome_source = 'ai_auto'), e só se ela ainda não tem tabulação.
 *     O run do fluxo NÃO é encerrado aqui: o fluxo segue o ramo da tag
 *     (mensagem de despedida, handoff…) por conta própria.
 *
 * O suggest-tag devolve a sugestão 'exit_tag' sem chamar o LLM.
 */

export const EXIT_TAG_SUGGESTION_CONFIDENCE = 1;

export interface ExitTagSuggestionInput {
  accountId: string;
  conversationId: string;
  exitTag: string;
  /** Código do handoff (ai_decisions.handoff_reason), quando houver. */
  handoffReason?: string | null;
}

export type ExitTagSuggestionResult =
  | "invalid_tag"
  | "no_mapping"
  | "not_found"
  | "closed"
  | "human_outcome"
  | "suggested"
  | "auto_closed";

interface MapRow {
  outcome_tag_id: string;
  auto_close: boolean | null;
}

interface ConversationRow {
  id: string;
  status: string;
  outcome_tag_id: string | null;
  outcome_source: string | null;
}

export function exitTagSuggestionReason(
  exitTag: string,
  handoffReason?: string | null,
): string {
  return handoffReason ? `${exitTag} — handoff: ${handoffReason}` : exitTag;
}

export async function applyExitTagOutcomeSuggestion(
  db: SupabaseClient,
  input: ExitTagSuggestionInput,
): Promise<ExitTagSuggestionResult> {
  const exitTag = normalizeExitTag(input.exitTag);
  if (!exitTag) return "invalid_tag";

  const { data: mapRows, error: mapError } = await db
    .from("ai_exit_tag_outcome_map")
    .select("outcome_tag_id, auto_close")
    .eq("account_id", input.accountId)
    .eq("exit_tag", exitTag)
    .limit(1);
  if (mapError) throw mapError;
  const mapping = (mapRows as MapRow[] | null)?.[0];
  if (!mapping) return "no_mapping";

  const { data: conversation, error: convError } = await db
    .from("conversations")
    .select("id, status, outcome_tag_id, outcome_source")
    .eq("id", input.conversationId)
    .eq("account_id", input.accountId)
    .maybeSingle();
  if (convError) throw convError;
  const conv = conversation as ConversationRow | null;
  if (!conv) return "not_found";
  if (conv.outcome_source === "human") return "human_outcome";
  if (conv.status === "closed") return "closed";

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    suggested_outcome_tag_id: mapping.outcome_tag_id,
    outcome_suggestion_source: "exit_tag",
    outcome_suggestion_confidence: EXIT_TAG_SUGGESTION_CONFIDENCE,
    outcome_suggestion_reason: exitTagSuggestionReason(exitTag, input.handoffReason),
    outcome_suggested_at: now,
    outcome_suggestion_key: null,
  };

  const autoClose = mapping.auto_close === true && !conv.outcome_tag_id;
  if (autoClose) {
    Object.assign(patch, {
      status: "closed",
      outcome_tag_id: mapping.outcome_tag_id,
      outcome_source: "ai_auto",
      outcome_set_by: null,
      outcome_set_at: now,
      updated_at: now,
    });
  }

  let query = db
    .from("conversations")
    .update(patch)
    .eq("id", conv.id)
    .eq("account_id", input.accountId)
    .neq("status", "closed");
  // Corrida com um fechamento humano entre a leitura e a escrita.
  if (autoClose) query = query.is("outcome_tag_id", null);
  const { error: updateError } = await query;
  if (updateError) throw updateError;

  return autoClose ? "auto_closed" : "suggested";
}

/**
 * Gancho do motor de fluxos (logAiDecision): toda decisão com
 * ai_exit_code vira sugestão. Fire-and-forget, nunca lança.
 */
export async function suggestOutcomeFromAiDecision(decision: {
  account_id: string;
  conversation_id?: string | null;
  ai_exit_code?: string | null;
  handoff_reason?: string | null;
}): Promise<void> {
  if (!decision.ai_exit_code || !decision.conversation_id) return;
  try {
    const { supabaseAdmin } = await import("@/lib/flows/admin-client");
    await applyExitTagOutcomeSuggestion(supabaseAdmin(), {
      accountId: decision.account_id,
      conversationId: decision.conversation_id,
      exitTag: decision.ai_exit_code,
      handoffReason: decision.handoff_reason ?? null,
    });
  } catch (err) {
    console.error("[outcome-suggestion] exit tag → sugestão falhou:", err);
  }
}
