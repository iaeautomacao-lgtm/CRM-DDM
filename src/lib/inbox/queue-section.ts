import type { Conversation } from "@/types";

export type InboxQueueSection = "attending" | "waiting" | "closed";

export const INBOX_QUEUE_LABELS: Record<InboxQueueSection, string> = {
  attending: "Em atendimento",
  waiting: "Em espera",
  closed: "Finalizada",
};

/**
 * Fila operacional do Inbox.
 *
 * conversations.status representa o estado do workflow e pode continuar
 * como pending mesmo depois de um atendente já ter sido escolhido. Para
 * o operador, a fonte de verdade da fila humana é a atribuição:
 * - ativa + atendente => Em atendimento
 * - ativa + sem atendente => Em espera
 * - closed => Finalizada
 */
export function inboxQueueSection(
  conversation: Pick<Conversation, "status" | "assigned_agent_id">,
): InboxQueueSection {
  if (conversation.status === "closed") return "closed";
  return conversation.assigned_agent_id ? "attending" : "waiting";
}
