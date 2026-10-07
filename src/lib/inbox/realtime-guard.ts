import type { ConversationStatus } from "@/types";

/**
 * Detecta UPDATE Realtime antigo que chegaria depois de um fechamento local.
 * Uma reabertura legítima precisa ter updated_at posterior ao instante em que
 * o navegador confirmou o fechamento.
 */
export function isStaleConversationUpdateAfterClose(
  locallyClosedAt: number | undefined,
  incoming: { status: ConversationStatus; updated_at: string },
): boolean {
  if (!locallyClosedAt || incoming.status === "closed") return false;
  const incomingUpdatedAt = Date.parse(incoming.updated_at);
  return !Number.isFinite(incomingUpdatedAt) || incomingUpdatedAt <= locallyClosedAt;
}
