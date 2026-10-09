// PRD 15, 15.14 — catálogo dos eventos dos webhooks de saída (API v1). Fonte única: a rota valida contra ele e o OpenAPI o documenta.
// Os triggers da migration 204 geram exatamente estes tipos; um evento novo = 1 entrada aqui + o trigger/RPC que o emite.

export const WEBHOOK_EVENTS = [
  "message.received", // mensagem de cliente chegou (qualquer canal)
  "message.status", // mensagem enviada mudou de status (sent/delivered/read/failed)
  "conversation.closed", // conversa encerrada (com a tabulação, se houver)
  "agreement.created", // tabulação "Acordo Realizado" (código 142) aplicada à conversa
  "contact.opt_out", // número entrou na blacklist com motivo opt_out
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Evento de teste (POST /webhooks/{id}/test): sempre permitido, nunca precisa ser assinado. */
export const WEBHOOK_TEST_EVENT = "webhook.test" as const;

export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEvent, string> = {
  "message.received": "Mensagem de cliente recebida (texto, telefone, conversa e contato).",
  "message.status": "Status de mensagem enviada alterado (sent, delivered, read, failed).",
  "conversation.closed": "Conversa encerrada, com a tabulação de encerramento quando houver.",
  "agreement.created": "Acordo registrado: tabulação 'Acordo Realizado' aplicada à conversa.",
  "contact.opt_out": "Contato pediu para não receber mensagens (opt-out).",
};

export const MAX_ENDPOINTS_PER_ACCOUNT = 10;
export const MAX_DELIVERY_ATTEMPTS = 12;

export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return typeof value === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** Valida e deduplica a lista de eventos; null = algum evento desconhecido ou lista vazia. */
export function parseWebhookEvents(input: unknown): WebhookEvent[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: WebhookEvent[] = [];
  for (const item of input) {
    if (!isWebhookEvent(item)) return null;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}
