// Nível de espera no cartão do Monitoramento: a MESMA regra da lista do Inbox (lib/inbox/wait-time), com o SLA de
// primeira resposta da equipe da conversa (lib/sla). Puro: o cartão só recebe números/strings, nunca objetos novos.

import { awaitingReplySince, waitLevel, waitMinutes, type WaitLevel } from "@/lib/inbox/wait-time";
import type { MonitorConversation } from "./queries";

export type CardWaitFields = Pick<MonitorConversation, "status" | "last_message_at" | "last_customer_message_at">;

/** Desde quando o cliente espera (ms), ou null se a última mensagem não é dele / a conversa fechou / faltam as datas. */
export function cardWaitSince(c: CardWaitFields): number | null {
  return awaitingReplySince({
    status: c.status,
    last_message_at: c.last_message_at ?? undefined,
    last_customer_message_at: c.last_customer_message_at ?? null,
  });
}

export interface CardWait {
  minutes: number;
  level: WaitLevel;
}

/** Minutos de espera e nível: passou do SLA = atrasado; passou do dobro = crítico. */
export function cardWait(sinceMs: number, nowMs: number, slaLimitMin: number): CardWait {
  const minutes = waitMinutes(sinceMs, nowMs);
  return { minutes, level: waitLevel(minutes, slaLimitMin) };
}
