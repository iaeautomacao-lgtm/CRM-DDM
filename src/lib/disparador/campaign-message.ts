// Funções puras usadas para ligar a resposta do cliente ao disparo que a
// originou (ver reply-tracker.ts). Sem I/O, para serem testáveis isoladas.

import { EXTERNAL_WAHA_TEXT_MARKER } from "./queue-markers";

/** Campos de disp_message_queue necessários para atribuir e exibir o disparo. */
export interface SentQueueItem {
  id: string;
  campaign_id: string;
  session_id: string | null;
  tipo: string | null;
  mensagem_final: string | null;
  media_url: string | null;
  template_name: string | null;
  template_language: string | null;
  template_variables: unknown;
  waha_message_id: string | null;
  sent_at: string;
  status: string;
}

/**
 * Último segmento de um id serializado do WAHA. O WAHA devolve ids como
 * `true_5511999999999@c.us_3EB0ABC...`, mas o `replyTo.id` de uma resposta
 * citada pode vir só com a chave final (`3EB0ABC...`). Ids da Meta
 * (`wamid.HBg...`) não têm `_` e voltam inteiros.
 */
export function providerMessageKey(id: string): string {
  const parts = id.split("_");
  return parts[parts.length - 1] ?? id;
}

/**
 * Encontra, entre os disparos recentes do contato, aquele que o cliente
 * citou ao responder (Meta `context.id` / WAHA `replyTo.id`). Compara o id
 * inteiro e, para o WAHA, também a chave final.
 */
export function matchQueueItemByProviderId<T extends Pick<SentQueueItem, "waha_message_id">>(
  items: readonly T[],
  replyToProviderId: string
): T | null {
  const exact = items.find((i) => i.waha_message_id === replyToProviderId);
  if (exact) return exact;
  const key = providerMessageKey(replyToProviderId);
  return (
    items.find((i) => i.waha_message_id && providerMessageKey(i.waha_message_id) === key) ?? null
  );
}

/**
 * Substitui `{{1}}`, `{{2}}`... do corpo do template Meta pelas variáveis do
 * disparo. Só para exibição no inbox: quem faz a substituição real no envio
 * é a própria Meta (array templateVariables). Links markdown viram URL pura,
 * igual ao que processQueue.sendViaMeta envia.
 */
export function renderMetaTemplateBody(body: string, variables: readonly string[]): string {
  return variables.reduce((text, raw, idx) => {
    const mdLink = raw.match(/\[.*?\]\((https?:\/\/[^)]+)\)/);
    const value = mdLink ? mdLink[1] : raw.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    return text.replace(new RegExp(`\\{\\{${idx + 1}\\}\\}`, "g"), value);
  }, body);
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v ?? "")) : [];
}

/**
 * Texto do disparo como o cliente recebeu, para o card no inbox. Ordem:
 * 1. template Meta com corpo conhecido → corpo renderizado com as variáveis;
 * 2. texto gravado no envio (message_logs.mensagem — já com {{nome}} etc.
 *    resolvidos e, no tipo IA, o texto que a IA gerou);
 * 3. contato externo WAHA → template_variables[0] (mensagem_final guarda o
 *    telefone nesse caso, ver EXTERNAL_WAHA_TEXT_MARKER);
 * 4. mensagem_final.
 */
export function campaignMessageText(
  item: Pick<SentQueueItem, "template_name" | "template_variables" | "mensagem_final">,
  opts: { templateBody?: string | null; loggedText?: string | null }
): string {
  const variables = toStringArray(item.template_variables);
  const isExternalWaha = item.template_name === EXTERNAL_WAHA_TEXT_MARKER;
  if (item.template_name && !isExternalWaha && opts.templateBody) {
    return renderMetaTemplateBody(opts.templateBody, variables);
  }
  if (opts.loggedText) return opts.loggedText;
  if (isExternalWaha) return variables[0] ?? "";
  return item.mensagem_final ?? "";
}

/** content_type de `messages` correspondente ao `tipo` do disparo. */
export function campaignContentType(
  item: Pick<SentQueueItem, "tipo" | "template_name">
): "text" | "template" | "image" | "video" | "audio" | "document" {
  if (item.template_name && item.template_name !== EXTERNAL_WAHA_TEXT_MARKER) return "template";
  switch (item.tipo) {
    case "imagem":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "arquivo":
      return "document";
    default:
      return "text";
  }
}

/** Status de `messages` equivalente ao status do item na fila. */
export function campaignMessageStatus(queueStatus: string): "sent" | "delivered" | "read" {
  if (queueStatus === "lido") return "read";
  if (queueStatus === "entregue") return "delivered";
  return "sent";
}
