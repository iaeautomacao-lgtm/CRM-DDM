// UTMpay → CRM: corpo do evento do funil (contrato de 14/10) e as regras puras de resultado. SEM CPF no corpo.
//   { event_id: uuid, tid, etapa: click|cpf_view|cpf_submit|payment_view|payment_start|paid, occurred_at: ISO8601, codigo, campanha, canal }
export const UTMPAY_STAGES = ["click", "cpf_view", "cpf_submit", "payment_view", "payment_start", "paid"] as const;
export type UtmpayStage = (typeof UTMPAY_STAGES)[number];

export const UTMPAY_MAX_BODY_BYTES = 8 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_TEXT = 120;

export interface UtmpayEvent {
  eventId: string;
  tid: string;
  etapa: UtmpayStage;
  occurredAt: Date;
  codigo: string | null;
  campanha: string | null;
  canal: string | null;
}

export type ParsedEvent = { ok: true; event: UtmpayEvent } | { ok: false; error: string };

const optionalText = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, SHORT_TEXT) : null);

export function parseUtmpayEvent(text: string): ParsedEvent {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: "JSON inválido" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "Corpo deve ser um objeto" };
  const b = body as Record<string, unknown>;
  if (typeof b.event_id !== "string" || !UUID.test(b.event_id)) return { ok: false, error: "event_id deve ser um UUID" };
  if (typeof b.tid !== "string" || !b.tid.trim() || b.tid.trim().length > 40) return { ok: false, error: "tid inválido" };
  if (typeof b.etapa !== "string" || !(UTMPAY_STAGES as readonly string[]).includes(b.etapa)) return { ok: false, error: "etapa inválida" };
  const occurred = typeof b.occurred_at === "string" ? new Date(b.occurred_at) : null;
  if (!occurred || Number.isNaN(occurred.getTime())) return { ok: false, error: "occurred_at deve ser ISO 8601" };
  return {
    ok: true,
    event: {
      eventId: b.event_id.toLowerCase(),
      tid: b.tid.trim(),
      etapa: b.etapa as UtmpayStage,
      occurredAt: occurred,
      codigo: optionalText(b.codigo),
      campanha: optionalText(b.campanha),
      canal: optionalText(b.canal),
    },
  };
}

/** Só o campo `tid` do corpo, sem validar o resto: serve para achar a conta (e o segredo) ANTES de conferir a assinatura. */
export function peekTid(text: string): string | null {
  try {
    const b = JSON.parse(text) as { tid?: unknown };
    return typeof b?.tid === "string" && b.tid.trim() && b.tid.trim().length <= 40 ? b.tid.trim() : null;
  } catch {
    return null;
  }
}

/** O evento caiu dentro da janela de atribuição (envio + N dias)? */
export function withinAttributionWindow(sentAt: Date, occurredAt: Date, windowDays: number): boolean {
  const limit = sentAt.getTime() + windowDays * 86_400_000;
  return occurredAt.getTime() <= limit;
}
