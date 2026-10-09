// Processamento de UMA mensagem recebida da Meta (contato → conversa → insert → fluxo/IA/automações).
// Extraído de api/whatsapp/webhook/route.ts SEM mudar regra: serve ao caminho inline (WHATSAPP_MESSAGE_INBOX=off/shadow)
// e ao drenador do inbox durável (message-inbox.ts, migration 201). Mensagem já gravada (23505) = idempotente.
import { chatMediaReference } from '@/lib/storage/chat-media'
import { auditFetch } from '@/lib/audit/context'
import { createClient } from '@supabase/supabase-js'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import type { WebhookContact } from '@/lib/whatsapp/webhook-contacts'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { maybeScheduleSentiment } from '@/lib/ai/sentiment-trigger'
import { reopenConversationFields } from '@/lib/conversations/reopen'
import { recordCampaignReply } from '@/lib/disparador/reply-tracker'
import { maybeStartCampaignWebchat } from '@/lib/webchat/campaign'
import { writeLog, maskPhone } from '@/lib/logger'

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        db: {
          schema: 'wacrm',
        },
        // Autor/IP para as triggers de auditoria (migration 131).
        global: { fetch: auditFetch },
      }
    ) as any
  }
  return _adminClient
}

export interface WhatsAppMessage {
  id: string
  from: string
  timestamp: string
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: {
    id: string
    mime_type: string
    filename?: string
    caption?: string
  }
  audio?: { id: string; mime_type: string }
  sticker?: { id: string; mime_type: string }
  location?: {
    latitude: number
    longitude: number
    name?: string
    address?: string
  }
  reaction?: { message_id: string; emoji: string }
  /** Resposta rápida (quick-reply) de template — ex.: botão de uma campanha. */
  button?: { text?: string; payload?: string }
  order?: {
    catalog_id?: string
    text?: string
    product_items?: Array<{ product_retailer_id?: string; quantity?: number }>
  }
  contacts?: Array<{
    name?: { formatted_name?: string }
    phones?: Array<{ phone?: string; wa_id?: string }>
  }>
  system?: { body?: string; type?: string; new_wa_id?: string }
  /**
   * Set when the customer taps a button or list row on an interactive
   * message we sent. `button_reply.id` / `list_reply.id` is whatever id
   * we put on the button/row when sending — the Flows engine uses this
   * to advance the per-contact run.
   */
  interactive?: {
    type: 'button_reply' | 'list_reply'
    button_reply?: { id: string; title: string }
    list_reply?: { id: string; title: string; description?: string }
  }
  /** Present when the customer swipe-replies to one of our messages. */
  context?: { id: string }
}


/**
 * Resolve a Meta-side message_id into the matching internal UUID, scoped
 * to one conversation. Returns null when we never received the parent
 * (e.g. a swipe-reply to a message older than this CRM install).
 */
async function lookupInternalIdByMetaId(
  metaId: string,
  conversationId: string
): Promise<string | null> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', metaId)
    .eq('conversation_id', conversationId)
    .maybeSingle()
  if (error) {
    console.error('[webhook] lookupInternalIdByMetaId failed:', error.message)
    return null
  }
  return data?.id ?? null
}

/**
 * Persist an inbound reaction. WhatsApp reactions are not new messages —
 * they're per-(target, actor) state. We upsert / delete on
 * `message_reactions`, never write a row into `messages`.
 *
 * Best-effort: a missing parent (we never received it) is logged and
 * skipped so the webhook still acks 200 to Meta.
 */
async function handleReaction(
  message: WhatsAppMessage,
  conversationId: string,
  contactId: string
) {
  const reaction = message.reaction
  if (!reaction?.message_id) return

  const targetInternalId = await lookupInternalIdByMetaId(
    reaction.message_id,
    conversationId
  )
  if (!targetInternalId) {
    console.warn(
      '[webhook] reaction target message not found; skipping',
      reaction.message_id
    )
    return
  }

  // Empty emoji = removal (per Meta's Cloud API spec).
  if (!reaction.emoji) {
    const { error: delError } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', targetInternalId)
      .eq('actor_type', 'customer')
      .eq('actor_id', contactId)
    if (delError) {
      console.error('[webhook] reaction delete failed:', delError.message)
    }
    return
  }

  const { error: upsertError } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: targetInternalId,
        conversation_id: conversationId,
        actor_type: 'customer',
        actor_id: contactId,
        emoji: reaction.emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upsertError) {
    console.error('[webhook] reaction upsert failed:', upsertError.message)
  }
}

/**
 * WH-21: o wamid já está em `messages`? Consulta barata (índice único idx_messages_message_id_unique) feita ANTES do
 * trabalho pesado (contato, conversa, download de mídia na Meta, upload ao Storage). Reentrega da Meta e retry do
 * drenador de uma mensagem já gravada viram `duplicate` sem refazer nada. Erro na consulta = "não sei": segue o
 * caminho normal (o 23505 do insert continua sendo a garantia final contra a corrida).
 */
async function messageAlreadyStored(wamid: string, accountId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('account_id', accountId)
    .eq('message_id', wamid)
    .limit(1)
  if (error) return false
  return Array.isArray(data) && data.length > 0
}

export type ProcessMessageOutcome = "processed" | "duplicate" | "reaction"

export async function processMessage(
  message: WhatsAppMessage,
  // Pode faltar (WH-03/WH-04): sem contato correspondente o nome fica vazio (contato novo = telefone).
  contact: WebhookContact | null | undefined,
  // Tenancy. Resolved from the matched whatsapp_config row; every
  // contact / conversation / message row created downstream is
  // stamped with this so any member of the account can see it.
  accountId: string,
  // Sender-of-record for inserts that need a NOT NULL user_id FK
  // (contacts, conversations). Always the admin who saved the
  // WhatsApp config; the choice is arbitrary post-017 but stable.
  configOwnerUserId: string,
  accessToken: string,
  // The matched whatsapp_config row's id — drives dispatchInboundToFlows'
  // per-channel flow_id binding (findEntryFlow in engine.ts). Without
  // this, a flow bound to a specific Meta number via /canais is
  // silently ignored and every inbound falls through to the
  // account-wide keyword/first-inbound scan instead.
  configId: string
): Promise<ProcessMessageOutcome> {
  // Reação não vira linha em `messages` (o wamid dela nunca está lá): só as demais passam pelo dedupe.
  if (message.type !== 'reaction' && message.id && (await messageAlreadyStored(message.id, accountId))) {
    console.log('[webhook] Mensagem duplicada ignorada (já gravada):', message.id)
    return "duplicate"
  }

  const senderPhone = normalizePhone(message.from)
  const contactName = String(contact?.profile?.name ?? '').trim()

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  )
  if (!contactOutcome) throw new Error("Falha ao localizar/criar o contato da mensagem recebida")
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const conversation = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
    configId
  )
  if (!conversation) throw new Error("Falha ao localizar/criar a conversa da mensagem recebida")

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return "reaction"
  }

  // Parse message content based on type
  const { contentText, mediaUrl, mediaType, interactiveReplyId } =
    await parseMessageContent(message, accessToken)

  // Resolve swipe-reply context if present. A missing parent is fine —
  // we just store NULL and the UI renders the message without a quote.
  let replyToInternalId: string | null = null
  if (message.context?.id) {
    replyToInternalId = await lookupInternalIdByMetaId(
      message.context.id,
      conversation.id
    )
    if (!replyToInternalId) {
      console.warn(
        '[webhook] reply context parent not found:',
        message.context.id
      )
    }
  }

  // Insert message — field names MUST match the messages table schema
  // (see supabase/migrations/001_initial_schema.sql):
  //   conversation_id, sender_type, content_type, content_text,
  //   media_url, template_name, message_id, status, created_at
  // `mediaType` is intentionally unused — the schema has no media_type
  // column; the MIME type is only used to construct the proxy URL during
  // parseMessageContent. Silence the unused-var warning:
  void mediaType

  // The messages.content_type CHECK constraint (widened in migration 010
  // to add 'interactive' for button/list taps) allows:
  //   text, image, document, audio, video, location, template, interactive
  // Map incoming WhatsApp types that aren't in that list to the closest
  // allowed value so the INSERT doesn't fail with a constraint error.
  const ALLOWED_CONTENT_TYPES = new Set([
    'text',
    'image',
    'document',
    'audio',
    'video',
    'location',
    'template',
    'interactive',
  ])
  const contentType = ALLOWED_CONTENT_TYPES.has(message.type)
    ? message.type
    : message.type === 'sticker'
      ? 'image' // stickers are images
      : 'text' // reaction, unknown → text fallback

  // Determine whether this is the contact's very first inbound message
  // BEFORE we insert, so the count is accurate. Covers the case where
  // the contact row already exists (manual add / CSV import) but they've
  // never messaged us before — which new_contact_created wouldn't catch.
  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await supabaseAdmin()
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: contentType,
      content_text: contentText,
      media_url: mediaUrl,
      message_id: message.id,
      status: 'delivered',
      created_at: new Date(parseInt(message.timestamp) * 1000).toISOString(),
      reply_to_message_id: replyToInternalId,
      // Only populated for content_type='interactive'. Migration 010 added
      // the column; null for every other content_type so existing inserts
      // behave identically.
      interactive_reply_id: interactiveReplyId,
    })

  if (msgError) {
    // 23505 = unique_violation na migration 088 (idx_messages_message_id_unique)
    // — Meta reentregou um evento que já processamos (retry por timeout/rede).
    // Não é um erro de verdade, só o sinal de "já inserida, não faz nada de
    // novo" — sem isso, redelivery duplicava a mensagem no inbox e incrementava
    // unread_count duas vezes.
    if (msgError.code === '23505') {
      console.log(
        '[webhook] Mensagem duplicada ignorada (já processada):',
        message.id
      )
      return "duplicate"
    }
    console.error("Error inserting message:", msgError)
    // Antes: só console.error + return (mensagem perdida, sem retry — WH-02). Agora sinaliza: o caminho inline
    // registra o erro; o drenador do inbox aplica backoff e, após N tentativas, marca dead.
    throw new Error(`Falha ao gravar a mensagem recebida: ${msgError.message}`)
  }

  // Update conversation. This function only ever handles an inbound
  // message (Meta doesn't echo the account's own outbound sends back
  // through this webhook the way WAHA does), so a customer replying to
  // a closed/tabulated conversation always means "reopen it" — surface
  // it back in the working queues (conversation-list.tsx's default
  // "Todos" view never shows status='closed') instead of leaving it
  // stuck in "Fechados" with an unread message no one is watching.
  const convUpdates: Record<string, unknown> = {
    last_message_text: contentText || `[${message.type}]`,
    last_message_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  if (conversation.status === 'closed') {
    // Reabertura = atendimento novo: status pending + tabulação zerada.
    Object.assign(convUpdates, reopenConversationFields())
  }
  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update(convUpdates)
    .eq('id', conversation.id)

  if (convError) {
    console.error('Error updating conversation:', convError)
  }

  // Increment atômico via RPC (migration 088) — o valor antigo
  // (`(conversation.unread_count || 0) + 1`) lia unread_count uma vez no
  // início da função e escrevia o calculado, então duas mensagens do
  // mesmo contato chegando em rajada podiam ler o mesmo valor base e uma
  // escrita perder o incremento da outra (lost update).
  const { error: unreadError } = await supabaseAdmin().rpc(
    'increment_unread_count',
    {
      conversation_id: conversation.id,
    }
  )
  if (unreadError) {
    console.error('Error incrementing unread_count:', unreadError)
  }

  // Correlacionar resposta com campanha do Disparador (se houver) e mostrar
  // o disparo na conversa — ver reply-tracker.ts. `context.id` é a mensagem
  // que o cliente citou; quando é a da campanha, a atribuição é exata.
  // Fire-and-forget: nunca deve atrasar/derrubar o processamento do webhook.
  recordCampaignReply({
    contactId: contactRecord.id,
    accountId,
    conversationId: conversation.id,
    inboundMessageId: message.id,
    replyToProviderId: message.context?.id ?? null,
    replyPhoneNormalized: senderPhone,
  }).catch(() => {})

  // ============================================================
  // Flow runner dispatch.
  //
  // If the runner consumes the message (it either advanced an active
  // run or started a new one), we suppress the `new_message_received`
  // + `keyword_match` automation triggers for this inbound. Customer
  // is navigating the bot menu, not sending a fresh trigger word
  // that should fork into automations.
  //
  // The relationship-level triggers (`new_contact_created`,
  // `first_inbound_message`) still fire even when consumed — those
  // are about WHO is messaging, not what they said.
  //
  // Awaited (not fire-and-forget) because we need the `consumed`
  // result before deciding whether to dispatch automations. The
  // runner has its own try/catch and never throws. Accounts with
  // no active flows take the runner's early-exit "no_match" path
  // basically for free (one indexed SELECT for the active run).
  //
  // Antes dos fluxos: resposta a uma campanha com a opção "enviar para o
  // Webchat" ligada recebe o convite e conta como tratada (sem fluxo
  // receptivo, sem IA global) — ver src/lib/webchat/campaign.ts.
  // ============================================================
  const movedToWebchat = await maybeStartCampaignWebchat({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    configId: configId ?? null,
    replyToProviderId: message.context?.id ?? null,
  })
  const flowResult = movedToWebchat
    ? { consumed: true }
    : await dispatchInboundToFlows({
    accountId,
    userId: configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    configId,
    message: interactiveReplyId
      ? {
          kind: 'interactive_reply',
          reply_id: interactiveReplyId,
          reply_title: contentText ?? '',
          meta_message_id: message.id,
        }
      : {
          kind: 'text',
          text: contentText ?? message.text?.body ?? '',
          meta_message_id: message.id,
        },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  // Trigger AI Auto Response / Sentiment / Auto-Tagging only when the flow
  // runner didn't already handle this inbound — mirrors the WAHA webhook's
  // guard (see waha/route.ts:531-555). Without the !flowConsumed check, an
  // account with an active ai_agent flow node would get handleAiAutoResponse
  // called twice for the same message: once here, once via
  // dispatchInboundToFlows -> runAiAgentCore -> that same function —
  // producing two AI replies to a single customer message. Sentiment/
  // auto-tagging are grouped in here too so a customer navigating the bot
  // menu (e.g. tapping "1") doesn't get analyzed as if it were a real
  // conversational message.
  if (!flowConsumed) {
    // Trigger AI Auto Response only when the conversation is not assigned
    // to a human and is not pending after a handoff. The flow dispatcher
    // deliberately treats status='pending' as human-owned even when no
    // agent was selected; the global responder must honor the same guard.
    if (!conversation.assigned_agent_id && conversation.status !== 'pending') {
      const { handleAiAutoResponse } = await import('@/lib/ai/responder')
      // Fire-and-forget — but handleAiAutoResponse now throws on an LLM
      // generation failure (see responder.ts), so this MUST catch or an
      // unhandled promise rejection would crash the whole process.
      void handleAiAutoResponse(
        accountId,
        contactRecord.id,
        conversation.id,
        contentText || '',
        undefined, // systemPromptOverride
        undefined, // skipDebounce
        undefined, // historyAfter
        undefined, // historyBefore
        undefined, // tools
        undefined, // onToolCall
        undefined, // onToolResult
        undefined, // nodeKey
        configId
      ).catch((err) => {
        console.error('[AI Agent] handleAiAutoResponse failed:', err)
        void writeLog({
          account_id: accountId,
          level: 'error',
          source: 'ai_agent',
          event: 'ai_agent_error',
          message: 'handleAiAutoResponse falhou no webhook Meta',
          payload: {
            contact_id: contactRecord.id,
            conversation_id: conversation.id,
            erro: err instanceof Error ? err.message : String(err),
          },
        })
      })
    }

    // Sugestão "Acordo Realizado" (fora de fluxo): com debounce, gravada
    // como sugestão para o atendente confirmar — ver acordo-tagging.ts.
    const { scheduleAcordoSuggestion } = await import('@/lib/ai/acordo-trigger')
    scheduleAcordoSuggestion(accountId, conversation.id)
  }

  // Sentimento: também com fluxo ativo (só texto de conversa, não toque
  // em menu/botão) — ver src/lib/ai/sentiment-trigger.ts.
  maybeScheduleSentiment(
    { accountId, contactId: contactRecord.id, conversationId: conversation.id },
    { text: contentText, flowConsumed, isInteractiveReply: Boolean(interactiveReplyId) },
  )

  // Fire any automations that react to this webhook event. All dispatches
  // run here (not earlier) so the contact, conversation, and inbound
  // message all exist before any step — including send_message — runs.
  // Fire-and-forget: a slow or failing automation must not block the
  // webhook's 200 OK response to Meta.
  const inboundText = contentText ?? message.text?.body ?? ''
  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []
  // Content-level triggers are suppressed when a flow consumed the
  // message — see the comment block above.
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }
  // new_contact_created fires only when the webhook just auto-created the
  // contact row. first_inbound_message fires whenever this is the contact's
  // first-ever customer-sent message — a superset that also catches
  // manually-imported contacts sending for the first time. We dispatch both
  // so users can pick whichever semantic they want; an automation that
  // listens to only one trigger runs only when that trigger matches.
  if (contactOutcome.wasCreated)
    automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      // Automação por linha (automations.line_ids, migration 128).
      lineId: configId ?? null,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
      },
    }).catch((err) => {
      console.error('[automations] dispatch failed:', err)
      void writeLog({
        account_id: accountId,
        level: 'error',
        source: 'automations',
        event: 'automation_dispatch_error',
        message: `Falha ao disparar automações para o trigger "${triggerType}"`,
        payload: {
          contact_id: contactRecord.id,
          trigger_type: triggerType,
          erro: err instanceof Error ? err.message : String(err),
        },
      })
    })
  }
  return "processed"
}

// Extensão de arquivo a partir do content-type — usada só pro nome do
// objeto no Storage, não precisa ser exaustiva (fallbackExt cobre o resto).
const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/amr': 'amr',
  'audio/aac': 'aac',
}

function extensionForMimeType(mimeType: string, fallbackExt: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase()
  return MIME_EXTENSION_MAP[base] || fallbackExt
}

// 5MB — restrição explícita do fix (só se aplica a imagem, ver chamada
// abaixo). 25MB é o limite documentado do Whisper (audio/transcriptions)
// — não faz sentido subir um áudio que a transcrição vai rejeitar de
// qualquer forma.
const MAX_META_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_META_AUDIO_BYTES = 25 * 1024 * 1024

// Baixa mídia da Meta (URL de CDN curta e autenticada, só resolvível com
// o access_token do canal) e reenvia pro bucket público `chat-media` do
// Supabase Storage, no mesmo padrão já usado pelo webhook WAHA. Sem isso,
// `messages.media_url` fica só com a rota /api/whatsapp/media/[mediaId]
// (protegida por sessão de usuário) — inacessível pra qualquer coisa que
// não seja o browser autenticado do CRM, incluindo a OpenAI (vision) e o
// Whisper (transcrição), que buscam a URL sem cookie nenhum.
//
// Retorna null em qualquer falha (mídia acima do limite, erro de rede,
// upload falho) — o caller cai de volta pra rota /api/whatsapp/media
// de sempre (ver verifyAndBuildUrl), preservando o comportamento atual.
async function downloadAndStoreMetaMedia(
  mediaId: string,
  accessToken: string,
  maxBytes: number,
  fallbackExt: string
): Promise<string | null> {
  try {
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    if (buffer.byteLength > maxBytes) {
      console.warn(
        `[webhook] Meta media ${mediaId} exceeds size limit (${buffer.byteLength} bytes > ${maxBytes}) — falling back to proxy URL.`
      )
      return null
    }

    const finalContentType =
      contentType || mediaInfo.mimeType || 'application/octet-stream'
    const ext = extensionForMimeType(finalContentType, fallbackExt)
    const storagePath = `meta/${mediaId}.${ext}`

    const { error: uploadError } = await supabaseAdmin()
      .storage.from('chat-media')
      .upload(storagePath, buffer, {
        contentType: finalContentType,
        upsert: true,
      })

    if (uploadError) {
      console.error(
        `[webhook] Failed to upload Meta media ${mediaId} to Storage:`,
        uploadError.message
      )
      void writeLog({
        level: 'warn',
        source: 'webhook_meta',
        event: 'media_upload_failed',
        message: `Falha ao subir mídia ${mediaId} para o Storage`,
        payload: { media_id: mediaId, erro: uploadError.message },
      })
      return null
    }

    return chatMediaReference(storagePath)
  } catch (err: any) {
    console.error(
      `[webhook] Failed to download/store Meta media ${mediaId}:`,
      err
    )
    void writeLog({
      level: 'warn',
      source: 'webhook_meta',
      event: 'media_upload_failed',
      message: `Falha ao baixar/armazenar mídia ${mediaId} da Meta`,
      payload: {
        media_id: mediaId,
        erro: err instanceof Error ? err.message : String(err),
      },
    })
    return null
  }
}

async function parseMessageContent(
  message: WhatsAppMessage,
  accessToken: string
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  mediaType: string | null
  /**
   * For interactive button / list replies: the stable id of the tapped
   * option (whatever we put on the button when sending). Used by the
   * Flows engine to advance the per-contact run; persisted to
   * `messages.interactive_reply_id` so the inbox bubble can render the
   * tap with the right affordance. Null for everything else.
   */
  interactiveReplyId: string | null
}> {
  // getMediaUrl signature is (mediaId, accessToken) — earlier code had
  // the args swapped, so every verification hit an invalid Meta URL and
  // fell through to the catch block, leaving mediaUrl as null. That's
  // why images showed up as empty bubbles in the inbox.
  const verifyAndBuildUrl = async (mediaId: string): Promise<string | null> => {
    try {
      await getMediaUrl({ mediaId, accessToken })
      return `/api/whatsapp/media/${mediaId}`
    } catch (error) {
      console.error(
        `Failed to verify media ${mediaId} with Meta:`,
        error instanceof Error ? error.message : error
      )
      return null
    }
  }

  // Default shape — each case overrides only the fields it cares about.
  // Keeps the new `interactiveReplyId` field DRY across every return site.
  const empty = {
    contentText: null,
    mediaUrl: null,
    mediaType: null,
    interactiveReplyId: null,
  }

  switch (message.type) {
    case 'text':
      return { ...empty, contentText: message.text?.body || null }

    case 'image':
      if (message.image?.id) {
        const mediaId = message.image.id
        // Tenta baixar + reenviar pro Storage público primeiro (necessário
        // pro agente de IA conseguir ver a imagem); cai pro proxy
        // autenticado de sempre se falhar por qualquer motivo.
        const storedUrl = await downloadAndStoreMetaMedia(
          mediaId,
          accessToken,
          MAX_META_IMAGE_BYTES,
          'jpg'
        )
        return {
          ...empty,
          contentText: message.image.caption || null,
          mediaUrl: storedUrl ?? (await verifyAndBuildUrl(mediaId)),
          mediaType: message.image.mime_type,
        }
      }
      return empty

    case 'video':
      if (message.video?.id) {
        return {
          ...empty,
          contentText: message.video.caption || null,
          mediaUrl: await verifyAndBuildUrl(message.video.id),
          mediaType: message.video.mime_type,
        }
      }
      return empty

    case 'document':
      if (message.document?.id) {
        return {
          ...empty,
          contentText:
            message.document.caption || message.document.filename || null,
          mediaUrl: await verifyAndBuildUrl(message.document.id),
          mediaType: message.document.mime_type,
        }
      }
      return empty

    case 'audio':
      if (message.audio?.id) {
        const mediaId = message.audio.id
        // Mesmo fix da imagem — responder.ts:420-433 (transcrição Whisper)
        // depende de media_url ser uma URL pública, mesmo problema de
        // /api/whatsapp/media/[mediaId] exigir sessão de usuário.
        const storedUrl = await downloadAndStoreMetaMedia(
          mediaId,
          accessToken,
          MAX_META_AUDIO_BYTES,
          'ogg'
        )
        return {
          ...empty,
          mediaUrl: storedUrl ?? (await verifyAndBuildUrl(mediaId)),
          mediaType: message.audio.mime_type,
        }
      }
      return empty

    case 'sticker':
      // Stickers are images under the hood. Treat them as such so the
      // MessageBubble renders the <img>. The caller maps the DB
      // content_type to 'image' for the CHECK constraint.
      if (message.sticker?.id) {
        return {
          ...empty,
          mediaUrl: await verifyAndBuildUrl(message.sticker.id),
          mediaType: message.sticker.mime_type,
        }
      }
      return empty

    case 'location':
      if (message.location) {
        const loc = message.location
        const locationText = [
          loc.name,
          loc.address,
          `${loc.latitude},${loc.longitude}`,
        ]
          .filter(Boolean)
          .join(' - ')
        return { ...empty, contentText: locationText }
      }
      return empty

    case 'reaction':
      return { ...empty, contentText: message.reaction?.emoji || null }

    case 'interactive': {
      // The customer tapped a reply button or a list row on a message
      // we previously sent. Meta delivers `interactive.button_reply` for
      // 3-button messages and `interactive.list_reply` for list messages.
      // Use the human-readable title as contentText so the inbox bubble
      // renders the tap legibly ("Existing customer"), and stash the
      // stable id separately so the Flows engine can route on it.
      const reply =
        message.interactive?.button_reply ?? message.interactive?.list_reply
      if (reply?.id) {
        return {
          ...empty,
          contentText: reply.title || reply.id,
          interactiveReplyId: reply.id,
        }
      }
      return { ...empty, contentText: '[Interactive reply]' }
    }

    // WH-06 (PRD 15): antes estes tipos viravam "[Unsupported message type: …]". Agora o conteúdo é legível.
    // EFEITO A JUSANTE (decisão do dono): este texto alimenta fluxos (coleta e keyword), automações
    // (keyword_match), IA, sentimento e last_message_text, exatamente como um texto digitado.
    case 'button': {
      // Quick-reply de template: o texto do botão que o cliente tocou.
      const text = message.button?.text?.trim() || message.button?.payload?.trim()
      return { ...empty, contentText: text || '[Unsupported message type: button]' }
    }

    case 'order': {
      const order = message.order
      const items = order?.product_items ?? []
      const total = items.reduce((sum, i) => sum + (Number(i?.quantity) > 0 ? Number(i.quantity) : 1), 0)
      const head = items.length > 0 ? `Pedido com ${total} ${total === 1 ? 'item' : 'itens'}` : 'Pedido'
      const note = order?.text?.trim()
      return { ...empty, contentText: note ? `${head}: ${note}` : head }
    }

    case 'contacts': {
      const shared = (message.contacts ?? [])
        .map((c) => {
          const name = c?.name?.formatted_name?.trim()
          const phone = c?.phones?.find((p) => p?.phone || p?.wa_id)
          const number = phone?.phone?.trim() || phone?.wa_id?.trim()
          return [name, number ? `(${number})` : null].filter(Boolean).join(' ')
        })
        .filter(Boolean)
      return {
        ...empty,
        contentText: shared.length > 0 ? `Contato compartilhado: ${shared.join('; ')}` : 'Contato compartilhado',
      }
    }

    case 'system': {
      const body = message.system?.body?.trim()
      return { ...empty, contentText: body ? `Mensagem do sistema: ${body}` : 'Mensagem do sistema' }
    }

    default:
      return {
        ...empty,
        contentText: `[Unsupported message type: ${message.type}]`,
      }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean
}

async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string
): Promise<ContactOutcome | null> {
  // Find an existing contact for this account by phone. The shared
  // helper pre-filters in SQL by the last-8-digit suffix (so we don't
  // pull every contact on every inbound message) then applies the
  // strict `phonesMatch` in JS on the small candidate set. The same
  // helper backs the manual contact form and CSV import, so all three
  // paths agree on what "same number" means (issue #212).
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone
  )

  if (existingContact) {
    // Update name if it changed
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  // Create new contact. account_id is the tenancy column;
  // user_id is the NOT NULL FK audit column (no inbound message
  // has a single "user who created" it — we attribute to the
  // WhatsApp config owner as a stable default).
  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and the
    // unique index (migration 022) rejected the duplicate. Re-resolve
    // the existing row instead of dropping the message.
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('Error creating contact:', createError)
    void writeLog({
      account_id: accountId,
      level: 'error',
      source: 'webhook_meta',
      event: 'contact_creation_failed',
      message: 'Falha ao criar contato a partir de mensagem inbound Meta',
      payload: { phone: maskPhone(phone), erro: createError.message },
    })
    return null
  }

  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
  configId: string
) {
  // Look for existing conversation in this account. `.single()` used to
  // throw PGRST116 (and silently fall through to creating a duplicate
  // conversation) whenever more than one row matched — `.limit(1)` +
  // ordering by most recent instead tolerates that and just picks the
  // latest conversation for this contact.
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    // Só conversas de WhatsApp: o mesmo contato pode ter uma conversa de
    // Webchat aberta (migration 127), que nunca recebe mensagens daqui.
    .eq('channel_type', 'whatsapp')
    .order('created_at', { ascending: false })
    .limit(1)

  if (!findError && existing && existing.length > 0) {
    const conv = existing[0] as { status: string } & (typeof existing)[0]
    // Conversa fechada → cria uma nova em vez de reutilizar.
    // Isso garante que um novo contato reinicie o fluxo do BEN
    // mesmo que já tenha sido atendido antes.
    if (conv.status !== 'closed') {
      return existing[0]
    }
    // Caso contrário, cai no create abaixo
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      // Which Meta whatsapp_config this conversation started on
      // (migration 069) — only set on creation, not backfilled onto
      // pre-existing conversations found above. Lets send/route.ts
      // (and anything else keyed on the channel) resolve the exact
      // config instead of guessing "the account's only Meta config".
      config_id: configId,
    })
    .select()
    .single()

  if (createError) {
    console.error('Error creating conversation:', createError)
    void writeLog({
      account_id: accountId,
      level: 'error',
      source: 'webhook_meta',
      event: 'contact_creation_failed',
      message: 'Falha ao criar conversa a partir de mensagem inbound Meta',
      payload: { contact_id: contactId, erro: createError.message },
    })
    return null
  }

  return newConv
}
