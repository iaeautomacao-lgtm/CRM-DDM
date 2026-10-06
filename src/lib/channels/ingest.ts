import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { dispatchInboundToFlows } from "@/lib/flows/engine";
import { maybeScheduleSentiment } from "@/lib/ai/sentiment-trigger";
import { runAutomationsForTrigger } from "@/lib/automations/engine";
import { chatMediaReference } from "@/lib/storage/chat-media";
import { MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";
import type { ParsedInbound } from "@/lib/flows/types";
import { decrypt } from "@/lib/whatsapp/encryption";
import { fetchSocialProfile } from "./graph";
import { socialAttachmentContentType, type SocialInboundEvent } from "./inbound";
import type { ChannelRow } from "./social";
import { reopenConversationFields } from "@/lib/conversations/reopen";

// Pipeline de entrada do Instagram/Messenger — mesma sequência dos webhooks
// de WhatsApp: canal → contato (por identidade do canal) → conversa da
// linha → mensagem → fluxos → IA global → automações da linha.

export async function ingestSocialEvent(ev: SocialInboundEvent): Promise<void> {
  const db = supabaseAdmin();

  const { data: channels } = await db
    .from("channels")
    .select("*")
    .eq("type", ev.type)
    .eq("external_id", ev.accountExternalId)
    .limit(1);
  const raw = channels?.[0] as ChannelRow & { connected_by: string | null } | undefined;
  if (!raw || !raw.habilitado) return;
  const channel = { ...raw, access_token: decrypt(raw.access_token) };
  const ownerUserId = raw.connected_by;
  if (!ownerUserId) {
    console.error("[social] canal sem connected_by, mensagem ignorada:", channel.id);
    return;
  }

  // Reentrega da Meta (retry/timeout): o índice único de message_id já
  // barraria o insert; checar antes evita baixar mídia de novo.
  const { data: dupe } = await db.from("messages").select("id").eq("message_id", ev.mid).limit(1);
  if (dupe?.length) return;

  const { contactId, created } = await resolveContact(channel, ownerUserId, ev);
  const conversation = await resolveConversation(channel, ownerUserId, contactId);

  const { contentType, contentText, mediaUrl, mime } = await buildContent(channel, ev);
  let replyToMessageId: string | null = null;
  if (ev.replyToMid) {
    const { data: parent } = await db
      .from("messages")
      .select("id")
      .eq("message_id", ev.replyToMid)
      .eq("conversation_id", conversation.id)
      .limit(1);
    replyToMessageId = parent?.[0]?.id ?? null;
  }

  const { count: priorCustomer } = await db
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversation.id)
    .eq("sender_type", "customer");

  const createdAt = new Date(ev.timestamp).toISOString();
  const { error: insertError } = await db.from("messages").insert({
    conversation_id: conversation.id,
    sender_type: "customer",
    content_type: ev.replyId ? "interactive" : contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: ev.mid,
    status: "delivered",
    created_at: createdAt,
    reply_to_message_id: replyToMessageId,
    interactive_reply_id: ev.replyId,
  });
  if (insertError) {
    if (insertError.code === "23505") return; // corrida com outra entrega
    throw new Error(`social message insert failed: ${insertError.message}`);
  }

  const convUpdates: Record<string, unknown> = {
    last_message_text: contentText || `[${contentType}]`,
    last_message_at: createdAt,
    updated_at: new Date().toISOString(),
  };
  if (conversation.status === "closed") Object.assign(convUpdates, reopenConversationFields());
  await db.from("conversations").update(convUpdates).eq("id", conversation.id);
  await db.rpc("increment_unread_count", { conversation_id: conversation.id });

  const message: ParsedInbound = ev.replyId
    ? { kind: "interactive_reply", reply_id: ev.replyId, reply_title: ev.text ?? "", meta_message_id: ev.mid, message_id: ev.mid }
    : mediaUrl
      ? { kind: "attachment", url: mediaUrl, mime_type: mime, message_id: ev.mid, meta_message_id: ev.mid }
      : { kind: "text", text: contentText ?? "", meta_message_id: ev.mid, message_id: ev.mid };

  const isFirstInboundMessage = (priorCustomer ?? 0) === 0;
  const flowResult = await dispatchInboundToFlows({
    accountId: channel.account_id,
    userId: ownerUserId,
    contactId,
    conversationId: conversation.id,
    channelId: channel.id,
    message,
    isFirstInboundMessage,
  });

  // IA global: mesmas guardas do WhatsApp (sem fluxo, sem atendente, fora
  // da fila humana).
  if (!flowResult.consumed && !conversation.assigned_agent_id && conversation.status !== "pending") {
    const { handleAiAutoResponse } = await import("@/lib/ai/responder");
    void handleAiAutoResponse(channel.account_id, contactId, conversation.id, contentText || "").catch(
      (err) => console.error("[social] IA falhou:", err),
    );
  }

  // Sentimento (antes os canais sociais nunca analisavam).
  maybeScheduleSentiment(
    { accountId: channel.account_id, contactId, conversationId: conversation.id },
    { text: contentText, flowConsumed: flowResult.consumed, isInteractiveReply: Boolean(ev.replyId) },
  );

  const triggers: Array<"new_contact_created" | "first_inbound_message" | "new_message_received" | "keyword_match"> = [];
  if (!flowResult.consumed) triggers.push("new_message_received", "keyword_match");
  if (created) triggers.unshift("new_contact_created");
  if (isFirstInboundMessage) triggers.unshift("first_inbound_message");
  for (const triggerType of triggers) {
    void runAutomationsForTrigger({
      accountId: channel.account_id,
      triggerType,
      contactId,
      lineId: channel.id,
      context: { message_text: contentText ?? "", conversation_id: conversation.id },
    }).catch((err) => console.error("[social] automação falhou:", err));
  }
}

/** Contato pela identidade do canal; cria (sem telefone) na primeira mensagem. */
async function resolveContact(
  channel: ChannelRow,
  ownerUserId: string,
  ev: SocialInboundEvent,
): Promise<{ contactId: string; created: boolean }> {
  const db = supabaseAdmin();
  const findIdentity = async () => {
    const { data } = await db
      .from("contact_identities")
      .select("contact_id")
      .eq("account_id", channel.account_id)
      .eq("channel_type", ev.type)
      .eq("channel_id", channel.id)
      .eq("external_id", ev.senderId)
      .limit(1);
    return data?.[0]?.contact_id as string | undefined;
  };
  const existing = await findIdentity();
  if (existing) return { contactId: existing, created: false };

  const profile = await fetchSocialProfile(ev.type, ev.senderId, channel.access_token);
  const { data: contact, error } = await db
    .from("contacts")
    .insert({
      account_id: channel.account_id,
      user_id: ownerUserId,
      phone: null,
      name: profile.name ?? (profile.username ? `@${profile.username}` : null),
      avatar_url: profile.avatarUrl,
    })
    .select("id")
    .limit(1);
  if (error || !contact?.[0]) throw new Error(`social contact insert failed: ${error?.message}`);
  const contactId = contact[0].id as string;

  const { error: identityError } = await db.from("contact_identities").insert({
    account_id: channel.account_id,
    contact_id: contactId,
    channel_type: ev.type,
    channel_id: channel.id,
    external_id: ev.senderId,
    display_name: profile.name,
    username: profile.username,
  });
  if (identityError) {
    // Corrida: outra entrega criou a identidade primeiro. Fica com a dela
    // e descarta o contato duplicado recém-criado.
    await db.from("contacts").delete().eq("id", contactId);
    const winner = await findIdentity();
    if (!winner) throw new Error(`social identity insert failed: ${identityError.message}`);
    return { contactId: winner, created: false };
  }
  return { contactId, created: true };
}

interface ConversationRow {
  id: string;
  status: "open" | "pending" | "closed";
  assigned_agent_id: string | null;
}

/** Última conversa do contato NESTA linha; fechada → abre outra (igual ao WhatsApp). */
async function resolveConversation(
  channel: ChannelRow,
  ownerUserId: string,
  contactId: string,
): Promise<ConversationRow> {
  const db = supabaseAdmin();
  const { data } = await db
    .from("conversations")
    .select("id, status, assigned_agent_id")
    .eq("account_id", channel.account_id)
    .eq("contact_id", contactId)
    .eq("channel_id", channel.id)
    .order("created_at", { ascending: false })
    .limit(1);
  const latest = data?.[0] as ConversationRow | undefined;
  if (latest && latest.status !== "closed") return latest;

  const { data: created, error } = await db
    .from("conversations")
    .insert({
      account_id: channel.account_id,
      user_id: ownerUserId,
      contact_id: contactId,
      channel_type: channel.type,
      channel_id: channel.id,
      status: "open",
    })
    .select("id, status, assigned_agent_id")
    .limit(1);
  if (error || !created?.[0]) throw new Error(`social conversation insert failed: ${error?.message}`);
  return created[0] as ConversationRow;
}

/**
 * Texto e mídia da mensagem. Anexos vêm numa URL temporária do CDN da
 * Meta: baixamos para o bucket privado chat-media (como o webhook de
 * WhatsApp faz), para a conversa não perder a mídia quando a URL expirar.
 */
async function buildContent(
  channel: ChannelRow,
  ev: SocialInboundEvent,
): Promise<{
  contentType: "text" | "image" | "video" | "audio" | "document";
  contentText: string | null;
  mediaUrl: string | null;
  mime: string;
}> {
  const attachment = ev.attachments.find((a) => a.url);
  if (!attachment?.url) return { contentType: "text", contentText: ev.text, mediaUrl: null, mime: "" };

  const kind = socialAttachmentContentType(attachment.type);
  if (kind === "text") {
    // Compartilhamento/menção em story: guarda o link como texto.
    return { contentType: "text", contentText: [ev.text, attachment.url].filter(Boolean).join("\n"), mediaUrl: null, mime: "" };
  }
  try {
    const res = await fetch(attachment.url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const mime = res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MEDIA_MAX_BYTES) throw new Error("arquivo acima do limite");
    const ext = mime.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
    const path = `account-${channel.account_id}/${channel.type}/${randomUUID()}.${ext}`;
    const { error } = await supabaseAdmin()
      .storage.from("chat-media")
      .upload(path, buffer, { contentType: mime, upsert: false });
    if (error) throw new Error(error.message);
    return { contentType: kind, contentText: ev.text, mediaUrl: chatMediaReference(path), mime };
  } catch (err) {
    console.error("[social] falha ao baixar anexo:", err);
    return { contentType: "text", contentText: ev.text ?? `[${attachment.type}]`, mediaUrl: null, mime: "" };
  }
}
