import type { SupabaseClient } from "@supabase/supabase-js";
import type { OutcomeSuggestionSource, Tag } from "@/types";

/**
 * Tabulações (tags kind='outcome') disponíveis para uma conversa — mesma
 * regra para o picker (browser) e para a sugestão da IA (servidor):
 *   - só as tags de desfecho da conta;
 *   - se a equipe da conversa tem mapeamento em team_outcome_tags
 *     (migration 107), só as mapeadas.
 * Sem dependência de servidor: roda com o client do browser ou do usuário.
 */
export async function loadOutcomeTagsForConversation(
  db: SupabaseClient,
  accountId: string,
  teamId: string | null | undefined,
): Promise<Tag[]> {
  const { data, error } = await db
    .from("tags")
    .select("*")
    .eq("account_id", accountId)
    .eq("kind", "outcome")
    .order("name");
  if (error || !data) return [];
  const tags = data as Tag[];

  if (!teamId) return tags;
  const { data: mapped, error: mapError } = await db
    .from("team_outcome_tags")
    .select("tag_id")
    .eq("team_id", teamId);
  if (mapError || !mapped || mapped.length === 0) return tags;
  const allowed = new Set((mapped as { tag_id: string }[]).map((m) => m.tag_id));
  return tags.filter((t) => allowed.has(t.id));
}

/** Sugestão como o suggest-tag devolve para o picker. */
export interface OutcomeSuggestionView {
  tag_id: string;
  tag_name: string;
  codigo_tabulacao: number | null;
  /** 0..1 */
  confidence: number;
  motivo: string;
  source: OutcomeSuggestionSource;
}

/** Confiança mínima de uma sugestão do LLM para já vir marcada no picker. */
export const PRESELECT_MIN_CONFIDENCE = 0.6;

/**
 * Qual tag o picker já abre marcada: a sugestão do fluxo (tag de saída)
 * sempre; a do LLM só com confiança suficiente. A tag precisa estar na
 * lista exibida (filtro por equipe).
 */
export function preselectedOutcomeTagId(
  tags: Pick<Tag, "id">[],
  suggestion: OutcomeSuggestionView | null | undefined,
  minConfidence = PRESELECT_MIN_CONFIDENCE,
): string | null {
  if (!suggestion) return null;
  if (!tags.some((t) => t.id === suggestion.tag_id)) return null;
  if (suggestion.source === "exit_tag") return suggestion.tag_id;
  return suggestion.confidence >= minConfidence ? suggestion.tag_id : null;
}

/** Rótulo da origem da sugestão no picker. */
export function suggestionSourceLabel(source: OutcomeSuggestionSource): string {
  return source === "exit_tag" ? "Fluxo" : "IA";
}
