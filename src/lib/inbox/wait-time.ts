// Espera do cliente no card da conversa (Inbox).
//
// "Esperando" = a última mensagem da conversa é do cliente (ninguém — nem
// atendente, nem robô — respondeu depois). Não há coluna de "última
// resposta"; o gatilho de SLA (migration 128) grava last_customer_message_at
// no mesmo instante em que a mensagem entra e o inbox atualiza
// last_message_at junto, então as duas datas coincidem quando a última
// mensagem é do cliente.

import type { Conversation } from "@/types";
import { SLA_TARGET_MINUTES } from "@/lib/monitoramento/sla";

type WaitFields = Pick<Conversation, "status" | "last_message_at" | "last_customer_message_at">;

/** Tolerância entre as duas datas (gravadas em instantes ligeiramente diferentes). */
const SAME_MESSAGE_TOLERANCE_MS = 5_000;

/** Limite padrão (min) quando a conta não configurou um: o mesmo do painel de SLA. */
export const DEFAULT_WAIT_LIMIT_MINUTES = SLA_TARGET_MINUTES;

/** Desde quando o cliente espera resposta (ms), ou null se não está esperando. */
export function awaitingReplySince(c: WaitFields): number | null {
  if (c.status === "closed" || !c.last_customer_message_at) return null;
  const customerAt = Date.parse(c.last_customer_message_at);
  if (!Number.isFinite(customerAt)) return null;
  const lastAt = c.last_message_at ? Date.parse(c.last_message_at) : NaN;
  if (Number.isFinite(lastAt) && lastAt - customerAt > SAME_MESSAGE_TOLERANCE_MS) return null;
  return customerAt;
}

/** Minutos inteiros de espera (nunca negativo). */
export function waitMinutes(sinceMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
}

/** Formato curto: "agora", "3 min", "1 h 20", "2 h", "2 d". */
export function formatWait(minutes: number): string {
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest}`;
  }
  return `${Math.floor(hours / 24)} d`;
}

export type WaitLevel = "ok" | "late" | "critical";

/** Passou do limite = atrasado; passou do dobro = crítico. */
export function waitLevel(minutes: number, limitMinutes: number = DEFAULT_WAIT_LIMIT_MINUTES): WaitLevel {
  if (minutes >= limitMinutes * 2) return "critical";
  if (minutes >= limitMinutes) return "late";
  return "ok";
}
