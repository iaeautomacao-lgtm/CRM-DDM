/**
 * Tabulação efetiva x sugestão (migration 157).
 *
 * outcome_tag_id é a tabulação que vale; outcome_source diz quem a
 * definiu. suggested_outcome_tag_id é só a sugestão da IA/fluxo e é
 * mantida depois do fechamento — comparar as duas dá a taxa de aceite.
 */

export type SuggestionVerdict = "accepted" | "changed" | "no_suggestion";

/** O humano aceitou ou trocou a sugestão? */
export function suggestionVerdict(
  suggestedOutcomeTagId: string | null | undefined,
  chosenOutcomeTagId: string,
): SuggestionVerdict {
  if (!suggestedOutcomeTagId) return "no_suggestion";
  return suggestedOutcomeTagId === chosenOutcomeTagId ? "accepted" : "changed";
}

/** PATCH do fechamento humano (/api/conversations/[id]/close). */
export function buildHumanClosePatch(input: {
  outcomeTagId: string;
  userId: string;
  assignedAgentId: string | null | undefined;
  now?: string;
}): Record<string, string> {
  const patch: Record<string, string> = {
    status: "closed",
    outcome_tag_id: input.outcomeTagId,
    outcome_source: "human",
    outcome_set_by: input.userId,
    outcome_set_at: input.now ?? new Date().toISOString(),
  };
  // Conversa sem dono fica com quem fechou (histórico explícito).
  if (!input.assignedAgentId) patch.assigned_agent_id = input.userId;
  return patch;
}
