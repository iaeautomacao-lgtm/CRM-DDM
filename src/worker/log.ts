// Linha de log do worker de envio (JSON, uma por evento). Os eventos do worker só levam contadores e ids (uuid), mas toda linha passa
// pela máscara de dados pessoais mesmo assim (PRD 14.7, console-pii.test): CPF via maskPiiArgs e telefone pelos 4 últimos dígitos.
import { maskPhoneForLog, maskPiiArgs } from "@/lib/privacy/mask";

const PHONE_KEY = /phone|telefone|celular|whatsapp_number|^to$/i;

function maskPhones(value: unknown, key = ""): unknown {
  if (typeof value === "string" && PHONE_KEY.test(key)) return maskPhoneForLog(value);
  if (Array.isArray(value)) return value.map((v) => maskPhones(v, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, maskPhones(v, k)]));
  }
  return value;
}

/** `{ ts, event, ...payload }` em JSON, com CPF e telefone mascarados. */
export function formatWorkerEvent(event: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify(maskPhones(maskPiiArgs({ ts: new Date().toISOString(), event, ...payload })));
}
