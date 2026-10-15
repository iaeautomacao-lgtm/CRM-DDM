// PRD 15, 15.14 — catálogo dos eventos dos webhooks de saída (API v1). Fonte única: a rota valida contra ele e o OpenAPI o documenta.
// Os triggers da migration 204 geram exatamente estes tipos; um evento novo = 1 entrada aqui + o trigger/RPC que o emite.

export const WEBHOOK_EVENTS = [
  "message.received", // mensagem de cliente chegou (qualquer canal)
  "message.status", // mensagem enviada mudou de status (sent/delivered/read/failed)
  "conversation.closed", // conversa encerrada (com a tabulação, se houver)
  "agreement.created", // tabulação "Acordo Realizado" (código 142) aplicada à conversa
  "contact.opt_out", // número entrou na blacklist com motivo opt_out
  "campaign.auto_paused", // campanha pausada automaticamente (taxa de erro, resultado incerto, IA fora) — alerta ativo, 1 por campanha/hora
  "channel.quality_changed", // qualidade do número Meta mudou (GREEN/YELLOW/RED) — alerta ativo, 1 por número/hora
  "dispatch.cron_stalled", // um cron do Disparador parou de bater — alerta ativo, 1 por cron/hora
  "campaign.started", // campanha iniciada (criada pela API e ativada, ou iniciada pelo painel)
  "campaign.paused", // pausa MANUAL (tela ou API); a automática é campaign.auto_paused
  "campaign.resumed", // retomada manual (tela ou API)
  "campaign.completed", // fila da campanha esgotada, com o resumo
  "campaign.cancelled", // encerramento manual (tela ou API), com o resumo
  "recipient.status", // destinatário de campanha chegou a um status FINAL: delivered, read, error, blocked ou removed (alto volume)
  "recipient.funnel", // destinatário clicou, fechou acordo ou pagou (link rastreado), com a atribuição (alto volume)
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
  "campaign.auto_paused": "Campanha pausada automaticamente, com o motivo (no máximo 1 aviso por campanha por hora).",
  "channel.quality_changed": "Qualidade do número Meta mudou, com a cor anterior e a nova (no máximo 1 aviso por número por hora).",
  "dispatch.cron_stalled": "Um cron do Disparador parou de bater (no máximo 1 aviso por cron por hora).",
  "campaign.started": "Campanha iniciada (criada pela API e ativada, ou iniciada pelo painel), com nome, external_id, origem, total de contatos e canal.",
  "campaign.paused": "Campanha pausada manualmente (tela ou API), com quem pausou e o motivo. A pausa automática é campaign.auto_paused.",
  "campaign.resumed": "Campanha retomada manualmente (tela ou API), com quem retomou e quantos itens voltaram à fila.",
  "campaign.completed": "Campanha concluída (fila esgotada), com o resumo: total, enviados, entregues, lidos, erros, bloqueados e cancelados.",
  "campaign.cancelled": "Campanha encerrada manualmente (tela ou API), com quem encerrou, o motivo e o resumo.",
  "recipient.status": "Destinatário chegou a um status final: delivered, read, error, blocked ou removed (tirado da campanha). Carrega o telefone; pode ser muito volumoso.",
  "recipient.funnel": "Destinatário avançou no funil do link rastreado: clicked, closed (fechou acordo) ou paid (pagou, confirmado na DDM), com a atribuição direct, ai ou human. Carrega o telefone; pode ser muito volumoso.",
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
