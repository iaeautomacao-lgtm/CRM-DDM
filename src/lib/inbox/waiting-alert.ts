// Aviso de conversa em espera (PRD 23, item 14) — regra pura.
//
// "Em espera" segue a fila do Inbox (lib/inbox/queue-section): ativa e sem
// atendente. O aviso dispara quando a conversa ENTRA na espera:
//   - chegou nova (INSERT) já sem atendente; ou
//   - estava com atendente e voltou para a fila (UPDATE).
// Atualização de conversa que já estava esperando (nova mensagem, por
// exemplo) não avisa de novo. Conversa desconhecida num UPDATE também não:
// a lista é filtrada pela aba, então "não conhecida" não quer dizer "nova".

import type { Conversation } from "@/types";
import { inboxQueueSection } from "@/lib/inbox/queue-section";

type QueueFields = Pick<Conversation, "status" | "assigned_agent_id">;

export function isWaitingConversation(c: QueueFields): boolean {
  return inboxQueueSection(c) === "waiting";
}

export function enteredWaiting(prev: QueueFields | null | undefined, next: QueueFields, isNew: boolean): boolean {
  if (!isWaitingConversation(next)) return false;
  if (isNew) return true;
  return !!prev && !isWaitingConversation(prev);
}
