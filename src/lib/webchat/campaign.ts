import { supabaseAdmin } from "@/lib/flows/admin-client";
import { resolveCampaignAttribution } from "@/lib/disparador/reply-tracker";
import { createWebchatSession, sendWebchatInvite } from "./sessions";

// Opção da campanha "Ao responder, enviar para o Webchat" (campaigns.webchat_*,
// migration 127). Chamada pelos webhooks de WhatsApp ANTES do motor de
// fluxos: se a resposta é a uma campanha com a opção ligada, o cliente
// recebe o convite e o fluxo receptivo da linha não começa.
//
// Só na primeira resposta àquele envio (trava em
// disp_message_queue.webchat_invited_at): se o cliente continuar falando no
// WhatsApp em vez de abrir o link, as próximas mensagens seguem o caminho
// normal (fluxos/IA/atendente). Também não convida quando a conversa já
// está com atendente ou o contato está no meio de outro fluxo.

export const DEFAULT_CAMPAIGN_WEBCHAT_MESSAGE =
  "Para continuarmos seu atendimento, toque no botão abaixo.";
export const DEFAULT_CAMPAIGN_WEBCHAT_BUTTON = "Abrir chat";

export interface CampaignWebchatInput {
  accountId: string;
  /** Dono da linha (sender-of-record do convite). */
  userId: string;
  contactId: string;
  /** Conversa de WhatsApp onde a resposta entrou. */
  conversationId: string;
  configId: string | null;
  /** Mensagem citada pelo cliente (Meta context.id / WAHA replyTo.id). */
  replyToProviderId: string | null;
}

/** true = convite enviado; o webhook não deve entregar a mensagem aos fluxos. */
export async function maybeStartCampaignWebchat(input: CampaignWebchatInput): Promise<boolean> {
  try {
    const attribution = await resolveCampaignAttribution(input);
    if (!attribution) return false;
    const { item } = attribution;
    const db = supabaseAdmin();

    const { data: campaigns, error: campaignError } = await db
      .from("campaigns")
      .select("webchat_enabled, webchat_flow_id, webchat_message, webchat_button_text")
      .eq("id", item.campaign_id)
      .eq("account_id", input.accountId)
      .limit(1);
    // Sem a migration 127 o select falha: segue o caminho antigo.
    if (campaignError) return false;
    const campaign = campaigns?.[0];
    if (!campaign?.webchat_enabled || !campaign.webchat_flow_id) return false;

    // Não interrompe um atendimento em andamento: conversa já com
    // atendente/na fila humana, ou contato no meio de outro fluxo.
    const [{ data: convRows }, { count: runCount }] = await Promise.all([
      db
        .from("conversations")
        .select("assigned_agent_id, status")
        .eq("id", input.conversationId)
        .limit(1),
      db
        .from("flow_runs")
        .select("id", { count: "exact", head: true })
        .eq("account_id", input.accountId)
        .eq("contact_id", input.contactId)
        .in("status", ["active", "paused_by_agent"]),
    ]);
    const conv = convRows?.[0];
    if (conv?.assigned_agent_id || conv?.status === "pending" || (runCount ?? 0) > 0) {
      return false;
    }

    // Trava atômica: só quem marca webchat_invited_at manda o convite.
    // Duas mensagens seguidas do cliente ou um retry do webhook não geram
    // dois links (o segundo revogaria o primeiro).
    const { data: claimed, error: claimError } = await db
      .from("disp_message_queue")
      .update({ webchat_invited_at: new Date().toISOString() })
      .eq("id", item.id)
      .is("webchat_invited_at", null)
      .select("id");
    if (claimError || !claimed?.length) return false;

    const { session, url } = await createWebchatSession({
      accountId: input.accountId,
      contactId: input.contactId,
      sourceConversationId: input.conversationId,
      configId: input.configId,
      flowId: campaign.webchat_flow_id,
      startNodeKey: null,
      campaignId: item.campaign_id,
      queueItemId: item.id,
      origin: "campaign",
    });
    await sendWebchatInvite({
      accountId: input.accountId,
      userId: input.userId,
      configId: input.configId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      url,
      text: campaign.webchat_message?.trim() || DEFAULT_CAMPAIGN_WEBCHAT_MESSAGE,
      buttonText: campaign.webchat_button_text?.trim() || DEFAULT_CAMPAIGN_WEBCHAT_BUTTON,
    });
    console.log("[webchat] convite de campanha enviado:", session.id);
    return true;
  } catch (err) {
    // Falha no convite não pode derrubar o webhook: a resposta segue o
    // caminho normal e o atendente ainda vê a conversa.
    console.error("[webchat] falha no convite da campanha:", err);
    return false;
  }
}
