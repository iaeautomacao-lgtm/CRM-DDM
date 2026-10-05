import { supabaseAdmin } from "@/lib/disparador/admin-client";
import { campaignContentType, campaignMessageText, type SentQueueItem } from "./campaign-message";

// Leituras do banco para reconstruir o disparo que o cliente recebeu.
// Usadas pelo reply-tracker (mensagem da campanha na conversa) e pelo
// Webchat (contexto inicial do fluxo/IA).

export const SENT_QUEUE_COLUMNS =
  "id, campaign_id, session_id, tipo, mensagem_final, media_url, template_name, template_language, template_variables, waha_message_id, sent_at, status";

/** Corpo do template Meta usado no envio (message_templates da conta). */
export async function loadTemplateBody(
  item: Pick<SentQueueItem, "template_name" | "template_language">,
  accountId: string
): Promise<string | null> {
  if (!item.template_name) return null;
  const { data } = await supabaseAdmin()
    .from("message_templates")
    .select("body_text")
    .eq("account_id", accountId)
    .eq("name", item.template_name)
    .eq("language", item.template_language ?? "pt_BR")
    .limit(1);
  return data?.[0]?.body_text ?? null;
}

/** Texto realmente enviado, gravado por mark_queue_item_sent em message_logs. */
export async function loadLoggedText(queueItemId: string): Promise<string | null> {
  const { data } = await supabaseAdmin()
    .from("message_logs")
    .select("mensagem")
    .eq("queue_id", queueItemId)
    .eq("direcao", "saida")
    .limit(1);
  return data?.[0]?.mensagem ?? null;
}

export interface CampaignContext {
  campaignId: string;
  campaignName: string | null;
  templateName: string | null;
  /** Texto do disparo como o cliente recebeu. */
  sentText: string;
}

/**
 * Campanha + texto enviado de um envio (disp_message_queue), escopado pela
 * conta. Null se o envio não existir nessa conta.
 */
export async function loadCampaignContext(
  accountId: string,
  queueItemId: string
): Promise<CampaignContext | null> {
  const db = supabaseAdmin();
  const { data } = await db
    .from("disp_message_queue")
    .select(SENT_QUEUE_COLUMNS)
    .eq("id", queueItemId)
    .eq("account_id", accountId)
    .limit(1);
  const item = data?.[0] as SentQueueItem | undefined;
  if (!item) return null;

  const [{ data: campaigns }, templateBody, loggedText] = await Promise.all([
    db.from("campaigns").select("nome").eq("id", item.campaign_id).limit(1),
    loadTemplateBody(item, accountId),
    loadLoggedText(item.id),
  ]);
  return {
    campaignId: item.campaign_id,
    campaignName: campaigns?.[0]?.nome ?? null,
    // Só template Meta de verdade (o marcador de contato externo WAHA não conta).
    templateName: campaignContentType(item) === "template" ? item.template_name : null,
    sentText: campaignMessageText(item, { templateBody, loggedText }),
  };
}
