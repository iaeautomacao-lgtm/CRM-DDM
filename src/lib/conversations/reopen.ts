/**
 * Campos gravados quando uma conversa FECHADA reabre porque o cliente
 * voltou a escrever (webhooks Meta/WAHA, Webchat e canais sociais).
 *
 * A reabertura é um atendimento novo: a tabulação do atendimento anterior
 * não vale para ele — se ficasse, o próximo fechamento já viria
 * "tabulado" com o desfecho antigo e a IA (acordo-tagging) nunca
 * reavaliaria a conversa. O desfecho anterior continua no log de
 * auditoria (migration 131).
 *
 * Cada webhook continua com o seu próprio UPDATE — este helper só
 * centraliza QUAIS campos zerar.
 */
export function reopenConversationFields(): Record<string, unknown> {
  return {
    status: "pending",
    outcome_tag_id: null,
  };
}
