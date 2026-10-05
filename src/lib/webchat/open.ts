import { supabaseAdmin } from "@/lib/flows/admin-client";
import { startWebchatRun } from "@/lib/flows/engine";
import { loadCampaignContext } from "@/lib/disparador/campaign-context";
import type { WebchatSessionRow } from "./sessions";

// Primeira abertura do link: cria a conversa de canal webchat e inicia o
// fluxo. Separado de sessions.ts porque importa o motor de fluxos (que por
// sua vez importa sessions.ts para o nó "Enviar para Webchat").

const WAIT_FOR_OPEN_ATTEMPTS = 10;
const WAIT_FOR_OPEN_MS = 300;

/**
 * Variáveis com que o fluxo começa no Webchat: as do run de origem mais o
 * contexto da campanha, para o fluxo/IA usarem em textos e no prompt:
 *   {{vars.campanha_nome}}, {{vars.template_nome}}, {{vars.mensagem_campanha}}
 */
export async function buildWebchatVars(
  session: WebchatSessionRow
): Promise<Record<string, unknown>> {
  const vars: Record<string, unknown> = { ...session.initial_vars, canal_origem: "whatsapp" };
  if (session.queue_item_id) {
    const ctx = await loadCampaignContext(session.account_id, session.queue_item_id);
    if (ctx) {
      vars.campanha_id = ctx.campaignId;
      vars.campanha_nome = ctx.campaignName ?? "";
      vars.template_nome = ctx.templateName ?? "";
      vars.mensagem_campanha = ctx.sentText;
    }
  }
  return vars;
}

/**
 * Garante a conversa de Webchat da sessão e devolve o id dela.
 *
 * Duas abas (ou um duplo toque no botão) podem chegar juntas: só quem
 * "carimba" opened_at cria a conversa e inicia o fluxo; a outra espera o
 * id aparecer na sessão.
 */
export async function openWebchatSession(session: WebchatSessionRow): Promise<string> {
  if (session.webchat_conversation_id) return session.webchat_conversation_id;
  const db = supabaseAdmin();

  const { data: claimed, error: claimError } = await db
    .from("webchat_sessions")
    .update({ opened_at: new Date().toISOString() })
    .eq("id", session.id)
    .is("opened_at", null)
    .select("id");
  if (claimError) throw new Error(`webchat open failed: ${claimError.message}`);

  if (!claimed?.length) {
    for (let i = 0; i < WAIT_FOR_OPEN_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, WAIT_FOR_OPEN_MS));
      const { data } = await db
        .from("webchat_sessions")
        .select("webchat_conversation_id")
        .eq("id", session.id)
        .limit(1);
      const id = data?.[0]?.webchat_conversation_id as string | null | undefined;
      if (id) return id;
    }
    throw new Error("webchat open timed out waiting for the conversation");
  }

  let conversationId: string;
  try {
    conversationId = await createWebchatConversation(session);
    const { error: linkError } = await db
      .from("webchat_sessions")
      .update({ webchat_conversation_id: conversationId })
      .eq("id", session.id);
    if (linkError) throw new Error(`webchat link failed: ${linkError.message}`);
  } catch (err) {
    // Libera o "carimbo" para a próxima tentativa recomeçar; sem isso o
    // link ficaria preso esperando uma conversa que nunca foi criada.
    await db
      .from("webchat_sessions")
      .update({ opened_at: null })
      .eq("id", session.id)
      .is("webchat_conversation_id", null);
    throw err;
  }

  if (session.flow_id) {
    const started = await startWebchatRun({
      accountId: session.account_id,
      contactId: session.contact_id,
      conversationId,
      configId: session.config_id,
      flowId: session.flow_id,
      startNodeKey: session.start_node_key,
      vars: await buildWebchatVars(session),
    });
    if (!started) {
      // Sem fluxo válido a conversa fica na fila para um atendente.
      await db.from("conversations").update({ status: "pending" }).eq("id", conversationId);
    }
  } else {
    await db.from("conversations").update({ status: "pending" }).eq("id", conversationId);
  }
  return conversationId;
}

async function createWebchatConversation(session: WebchatSessionRow): Promise<string> {
  const db = supabaseAdmin();
  // user_id (NOT NULL, auditoria) = o mesmo da conversa de WhatsApp de
  // origem; sem ela, o dono da linha.
  let userId: string | null = null;
  if (session.source_conversation_id) {
    const { data } = await db
      .from("conversations")
      .select("user_id")
      .eq("id", session.source_conversation_id)
      .limit(1);
    userId = data?.[0]?.user_id ?? null;
  }
  if (!userId && session.config_id) {
    const { data } = await db
      .from("whatsapp_config")
      .select("user_id")
      .eq("id", session.config_id)
      .limit(1);
    userId = data?.[0]?.user_id ?? null;
  }
  if (!userId) throw new Error("webchat open failed: no owner user for the conversation");

  const now = new Date().toISOString();
  const { data, error } = await db
    .from("conversations")
    .insert({
      account_id: session.account_id,
      user_id: userId,
      contact_id: session.contact_id,
      channel_type: "webchat",
      status: "open",
      // config_id = linha de origem: o trigger da migration 104 copia o
      // team_id dela, então a conversa cai na equipe responsável pela linha.
      config_id: session.config_id,
      last_message_at: now,
      ...(session.campaign_id
        ? { origin_campaign_id: session.campaign_id, origin_queue_item_id: session.queue_item_id }
        : {}),
    })
    .select("id")
    .limit(1);
  if (error || !data?.[0]) {
    throw new Error(`webchat conversation insert failed: ${error?.message ?? "no row"}`);
  }
  return data[0].id as string;
}
