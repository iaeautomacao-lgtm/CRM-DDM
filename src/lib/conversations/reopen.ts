/**
 * Campos gravados quando uma conversa FECHADA reabre porque o cliente
 * voltou a escrever (webhooks Meta/WAHA, Webchat e canais sociais).
 *
 * A reabertura é um atendimento novo: a tabulação do atendimento anterior
 * (e a sua procedência) e a sugestão da IA/fluxo não valem para ele — se
 * ficassem, o próximo fechamento já viria "tabulado" com o desfecho
 * antigo e a IA nunca reavaliaria a conversa. O desfecho anterior
 * continua no log de auditoria (migration 131).
 *
 * Cada webhook continua com o seu próprio UPDATE — este helper só
 * centraliza QUAIS campos zerar.
 */
export function reopenConversationFields(): Record<string, unknown> {
  return {
    status: "pending",
    outcome_tag_id: null,
    // Procedência da tabulação (migration 157).
    outcome_source: null,
    outcome_set_by: null,
    outcome_set_at: null,
    // Sugestão (migration 157).
    ...clearedOutcomeSuggestionFields(),
  };
}

/** Zera a sugestão de tabulação (suggested_* / outcome_suggestion_*). */
export function clearedOutcomeSuggestionFields(): Record<string, null> {
  return {
    suggested_outcome_tag_id: null,
    outcome_suggestion_source: null,
    outcome_suggestion_confidence: null,
    outcome_suggestion_reason: null,
    outcome_suggested_at: null,
    outcome_suggestion_key: null,
  };
}
