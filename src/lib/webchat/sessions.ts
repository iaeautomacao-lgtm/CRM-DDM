import { supabaseAdmin } from "@/lib/flows/admin-client";
import { engineSendCtaUrl } from "@/lib/flows/meta-send";
import { engineWahaSendText } from "@/lib/flows/waha-send";
import {
  WEBCHAT_TTL_MS,
  generateWebchatToken,
  hashWebchatToken,
  isWellFormedWebchatToken,
  webchatUrl,
} from "./token";

// Sessões do Webchat (wacrm.webchat_sessions, migration 127).
//
// Ciclo de vida:
//   1. createWebchatSession — gerada pelo nó "Enviar para Webchat" ou pela
//      opção da campanha. Revoga a sessão ativa anterior do contato (um
//      link por número) e devolve o token em claro UMA vez, para a URL.
//   2. sendWebchatInvite — manda o link no WhatsApp (botão na Meta, texto
//      no WAHA).
//   3. openWebchatSession (open.ts) — na primeira visita: cria a conversa
//      de canal webchat e inicia o fluxo.
//   4. resolveWebchatSession — toda chamada da página valida o token.
//
// Este arquivo não importa o motor de fluxos (o motor importa daqui);
// a abertura, que precisa do motor, fica em open.ts para não criar ciclo.

export interface WebchatSessionRow {
  id: string;
  account_id: string;
  contact_id: string;
  source_conversation_id: string | null;
  webchat_conversation_id: string | null;
  config_id: string | null;
  flow_id: string | null;
  start_node_key: string | null;
  initial_vars: Record<string, unknown>;
  campaign_id: string | null;
  queue_item_id: string | null;
  origin: "flow_node" | "campaign";
  status: "active" | "revoked" | "expired";
  expires_at: string;
  opened_at: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface CreateWebchatSessionInput {
  accountId: string;
  contactId: string;
  sourceConversationId: string | null;
  configId: string | null;
  flowId: string | null;
  startNodeKey: string | null;
  initialVars?: Record<string, unknown>;
  campaignId?: string | null;
  queueItemId?: string | null;
  origin: "flow_node" | "campaign";
}

export async function createWebchatSession(
  input: CreateWebchatSessionInput
): Promise<{ session: WebchatSessionRow; token: string; url: string }> {
  const db = supabaseAdmin();
  const token = generateWebchatToken();
  // webchatUrl lança se NEXT_PUBLIC_APP_URL faltar — antes de gravar nada.
  const url = webchatUrl(token);

  // Um link por contato: revoga o anterior antes de inserir o novo. O
  // índice único parcial (status='active') protege contra corrida; se
  // outra requisição inseriu no meio, revoga e tenta uma vez mais.
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error: revokeError } = await db
      .from("webchat_sessions")
      .update({ status: "revoked" })
      .eq("account_id", input.accountId)
      .eq("contact_id", input.contactId)
      .eq("status", "active");
    if (revokeError) throw new Error(`webchat revoke failed: ${revokeError.message}`);

    const { data, error } = await db
      .from("webchat_sessions")
      .insert({
        account_id: input.accountId,
        contact_id: input.contactId,
        source_conversation_id: input.sourceConversationId,
        config_id: input.configId,
        flow_id: input.flowId,
        start_node_key: input.startNodeKey,
        initial_vars: input.initialVars ?? {},
        campaign_id: input.campaignId ?? null,
        queue_item_id: input.queueItemId ?? null,
        origin: input.origin,
        token_hash: hashWebchatToken(token),
        expires_at: new Date(Date.now() + WEBCHAT_TTL_MS).toISOString(),
      })
      .select("*")
      .limit(1);
    if (!error && data?.[0]) {
      return { session: data[0] as WebchatSessionRow, token, url };
    }
    if (error?.code !== "23505") {
      throw new Error(`webchat session insert failed: ${error?.message ?? "no row"}`);
    }
  }
  throw new Error("webchat session insert failed: concurrent invite for the same contact");
}

export type ResolvedWebchatSession =
  | { state: "active"; session: WebchatSessionRow }
  | { state: "expired" | "revoked" | "not_found" };

/**
 * Valida o token da URL. Sessão vencida é marcada como 'expired' na
 * primeira leitura depois do prazo, para o inbox e relatórios refletirem.
 */
export async function resolveWebchatSession(token: string): Promise<ResolvedWebchatSession> {
  if (!isWellFormedWebchatToken(token)) return { state: "not_found" };
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("webchat_sessions")
    .select("*")
    .eq("token_hash", hashWebchatToken(token))
    .limit(1);
  if (error) throw new Error(`webchat session lookup failed: ${error.message}`);
  const session = data?.[0] as WebchatSessionRow | undefined;
  if (!session) return { state: "not_found" };
  if (session.status === "revoked") return { state: "revoked" };
  if (session.status === "expired") return { state: "expired" };
  if (Date.parse(session.expires_at) <= Date.now()) {
    await db.from("webchat_sessions").update({ status: "expired" }).eq("id", session.id);
    return { state: "expired" };
  }
  return { state: "active", session };
}

/**
 * A conversa de Webchat ainda tem um link válido (ativo e dentro das 24h)?
 * Sem ele o cliente não consegue mais ver mensagens novas lá: usado para
 * encerrar o run abandonado no Webchat e para avisar o atendente no inbox.
 */
export async function hasActiveWebchatSession(conversationId: string): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from("webchat_sessions")
    .select("id")
    .eq("webchat_conversation_id", conversationId)
    .eq("status", "active")
    .gt("expires_at", new Date().toISOString())
    .limit(1);
  return !!data?.length;
}

export interface SendWebchatInviteInput {
  accountId: string;
  userId: string;
  /** Linha de WhatsApp por onde o convite sai (whatsapp_config.id). */
  configId: string | null;
  /** Conversa de WhatsApp onde o convite é gravado. */
  conversationId: string;
  contactId: string;
  url: string;
  text: string;
  buttonText: string;
}

/**
 * Manda o link do Webchat no WhatsApp. Meta e WAHA ficam em caminhos
 * separados (regra do projeto):
 * - Meta: mensagem interativa com botão de URL (cta_url);
 * - WAHA: não há botão de URL — o link vai no fim do texto.
 */
export async function sendWebchatInvite(
  input: SendWebchatInviteInput
): Promise<{ whatsapp_message_id: string }> {
  let isMetaChannel = true;
  if (input.configId) {
    const { data } = await supabaseAdmin()
      .from("whatsapp_config")
      .select("provider")
      .eq("id", input.configId)
      .eq("account_id", input.accountId)
      .limit(1);
    isMetaChannel = data?.[0]?.provider !== "waha";
  }

  if (isMetaChannel) {
    return engineSendCtaUrl({
      accountId: input.accountId,
      userId: input.userId,
      conversationId: input.conversationId,
      contactId: input.contactId,
      bodyText: input.text,
      displayText: input.buttonText,
      url: input.url,
      configId: input.configId ?? undefined,
    });
  }
  // O link vai ao cliente, mas no banco fica oculto: quem tem o link fala
  // como o cliente, e o inbox é visto por toda a equipe.
  return engineWahaSendText({
    accountId: input.accountId,
    configId: input.configId!,
    conversationId: input.conversationId,
    contactId: input.contactId,
    text: `${input.text}\n\n${input.url}`,
    storedText: `${input.text}\n\n[link do Webchat]`,
  });
}
