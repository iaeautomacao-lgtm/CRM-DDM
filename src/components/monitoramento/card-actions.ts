import type { MonitorConversation } from "@/lib/monitoramento/queries";

/**
 * Bundle of selection + menu-action callbacks shared by every column
 * type (Fases/Agentes/Equipes) — one object built once in page.tsx
 * per tab, passed down to each column, which unpacks it into the
 * individual props ConversationCard actually takes. Keeps the
 * column<->page prop lists short instead of 6+ separate props each.
 */
export interface ConversationCardActions {
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: (ids: string[], value: boolean) => void;
  onTransferClick: (conversation: MonitorConversation) => void;
  onFinalizeClick: (conversation: MonitorConversation) => void;
  onHistoryClick: (conversation: MonitorConversation) => void;
  getTeamName: (teamId: string | null) => string | null;
  getAgentName: (agentId: string | null) => string | null;
}
