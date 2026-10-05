import type { ConversationStatus } from "@/types";

// Rótulos únicos do status da conversa no Inbox (lista, filtros e menu do
// cabeçalho da conversa). Cores e estrutura ficam em cada componente.
export const CONVERSATION_STATUS_LABELS: Record<ConversationStatus, string> = {
  open: "Em atendimento",
  pending: "Em espera",
  closed: "Finalizada",
};

// Plural para filtros/seções que listam várias conversas.
export const CONVERSATION_STATUS_LABELS_PLURAL: Record<ConversationStatus, string> = {
  open: "Em atendimento",
  pending: "Em espera",
  closed: "Finalizadas",
};
