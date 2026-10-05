import { randomUUID } from 'node:crypto'
import { after } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { maybeScheduleSentiment } from '@/lib/ai/sentiment-trigger'
import type { ParsedInbound } from '@/lib/flows/types'
import { chatMediaReference } from '@/lib/storage/chat-media'
import { MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media'
import {
  WEBCHAT_LIMITS,
  requireActiveSession,
  webchatError,
  webchatJson,
  webchatUploadPrefix,
} from '@/lib/webchat/api'
import { WEBCHAT_ALLOWED_MIME, mediaKindFromMime, toClientMessage } from '@/lib/webchat/messages'

// /api/webchat/[token]/messages
//
// GET  ?after=<ISO> — mensagens novas da conversa (a página consulta a
//      cada poucos segundos: o Passenger não mantém conexões abertas, então
//      não há websocket/SSE). Marca como lidas as mensagens da empresa.
// POST — mensagem do cliente (texto, resposta de botão ou anexo já enviado
//      ao Storage via /upload). Grava, atualiza a conversa e entrega ao
//      motor de fluxos depois da resposta (after()).

const MESSAGE_COLUMNS =
  'id, sender_type, content_type, content_text, media_url, interactive_payload, created_at'

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const result = await requireActiveSession(token)
  if ('response' in result) return result.response
  const { session } = result
  if (!session.webchat_conversation_id) return webchatError('not_open', 409)

  const after = new URL(request.url).searchParams.get('after')
  const db = supabaseAdmin()
  let query = db
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('conversation_id', session.webchat_conversation_id)
    .order('created_at', { ascending: true })
    .limit(WEBCHAT_LIMITS.pageSize)
  if (after && !Number.isNaN(Date.parse(after))) query = query.gt('created_at', after)
  const { data, error } = await query
  if (error) {
    console.error('[webchat/messages] falha ao buscar mensagens:', error.message)
    return webchatJson({ state: 'error', error: 'Não foi possível carregar as mensagens' }, 503)
  }

  // "Lido" para o atendente = a página do cliente recebeu a mensagem. Só
  // as ids devolvidas nesta resposta, nunca a conversa inteira.
  const now = new Date().toISOString()
  const deliveredIds = (data ?? [])
    .filter((row) => row.sender_type !== 'customer')
    .map((row) => row.id)
  if (deliveredIds.length > 0) {
    void db
      .from('messages')
      .update({ status: 'read' })
      .in('id', deliveredIds)
      .in('status', ['sent', 'delivered'])
      .then(({ error: readError }) => {
        if (readError) console.error('[webchat/messages] falha ao marcar lidas:', readError.message)
      })
  }
  void db.from('webchat_sessions').update({ last_seen_at: now }).eq('id', session.id).then(() => {})

  return webchatJson({
    state: 'active',
    messages: (data ?? []).map((row) => toClientMessage(token, row)),
  })
}

interface PostBody {
  text?: unknown
  reply_id?: unknown
  reply_title?: unknown
  media?: { path?: unknown; mime_type?: unknown; name?: unknown }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const result = await requireActiveSession(token)
  if ('response' in result) return result.response
  const { session } = result
  const conversationId = session.webchat_conversation_id
  if (!conversationId) return webchatError('not_open', 409)

  let body: PostBody
  try {
    body = (await request.json()) as PostBody
  } catch {
    return webchatError('invalid', 400, 'Corpo inválido')
  }
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  const replyId = typeof body.reply_id === 'string' ? body.reply_id : null
  const replyTitle = typeof body.reply_title === 'string' ? body.reply_title : ''
  const mediaPath = typeof body.media?.path === 'string' ? body.media.path : null
  const mediaMime = typeof body.media?.mime_type === 'string' ? body.media.mime_type : ''
  const mediaName = typeof body.media?.name === 'string' ? body.media.name : null

  if (!text && !replyId && !mediaPath) return webchatError('invalid', 400, 'Mensagem vazia')
  if (text.length > WEBCHAT_LIMITS.textMaxLength) {
    return webchatError('invalid', 400, 'Mensagem muito longa')
  }
  // Anexo: só aceita o caminho que /upload gerou para ESTA sessão.
  if (mediaPath) {
    if (!mediaPath.startsWith(webchatUploadPrefix(session)) || mediaPath.includes('..')) {
      return webchatError('invalid', 400, 'Anexo inválido')
    }
    if (!WEBCHAT_ALLOWED_MIME.test(mediaMime)) {
      return webchatError('invalid', 400, 'Tipo de arquivo não permitido')
    }
  }

  const db = supabaseAdmin()

  // A URL assinada de upload não impõe tamanho nem tipo: confere o objeto
  // que de fato chegou ao Storage e usa o mimetype gravado lá, não o
  // declarado pelo navegador. Fora do permitido, apaga e recusa.
  let storedMime = mediaMime
  if (mediaPath) {
    const slash = mediaPath.lastIndexOf('/')
    const folder = mediaPath.slice(0, slash)
    const fileName = mediaPath.slice(slash + 1)
    const { data: objects } = await db.storage
      .from('chat-media')
      .list(folder, { search: fileName, limit: 5 })
    const object = objects?.find((o) => o.name === fileName)
    const metadata = (object?.metadata ?? {}) as { size?: number; mimetype?: string }
    storedMime = metadata.mimetype ?? ''
    const tooBig =
      typeof metadata.size !== 'number' ||
      metadata.size > MEDIA_MAX_BYTES_BY_KIND[mediaKindFromMime(storedMime)]
    if (!object || !WEBCHAT_ALLOWED_MIME.test(storedMime) || tooBig) {
      if (object) await db.storage.from('chat-media').remove([mediaPath])
      return webchatError('invalid', 400, 'Arquivo não permitido')
    }
  }

  const { data: convRows, error: convError } = await db
    .from('conversations')
    .select('id, user_id, status')
    .eq('id', conversationId)
    .eq('account_id', session.account_id)
    .limit(1)
  const conversation = convRows?.[0]
  if (convError || !conversation) return webchatError('not_open', 409)

  // Anti-flood por sessão.
  const { count } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'customer')
    .gt('created_at', new Date(Date.now() - 60_000).toISOString())
  if ((count ?? 0) >= WEBCHAT_LIMITS.messagesPerMinute) {
    return webchatError('rate_limited', 429, 'Muitas mensagens. Aguarde um instante.')
  }

  const messageId = `webchat-in-${randomUUID()}`
  const mediaKind = mediaPath ? mediaKindFromMime(storedMime) : null
  const mediaUrl = mediaPath ? chatMediaReference(mediaPath) : null
  const contentType = mediaKind ?? (replyId ? 'interactive' : 'text')
  const contentText = mediaKind ? text || mediaName : replyId ? replyTitle || text : text
  const now = new Date().toISOString()

  const { data: inserted, error: insertError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'customer',
      content_type: contentType,
      content_text: contentText || null,
      media_url: mediaUrl,
      interactive_reply_id: replyId,
      message_id: messageId,
      status: 'delivered',
      created_at: now,
    })
    .select(MESSAGE_COLUMNS)
    .limit(1)
  if (insertError || !inserted?.[0]) {
    console.error('[webchat/messages] falha ao gravar mensagem:', insertError?.message)
    return webchatJson({ state: 'error', error: 'Não foi possível enviar' }, 503)
  }

  // Conversa: prévia, reabre se estava fechada (igual aos webhooks) e
  // incrementa não lidas de forma atômica (RPC da migration 088).
  const convUpdates: Record<string, unknown> = {
    last_message_text: contentText || `[${contentType}]`,
    last_message_at: now,
    updated_at: now,
  }
  if (conversation.status === 'closed') convUpdates.status = 'pending'
  await db.from('conversations').update(convUpdates).eq('id', conversationId)
  const { error: unreadError } = await db.rpc('increment_unread_count', {
    conversation_id: conversationId,
  })
  if (unreadError) console.error('[webchat/messages] falha em unread_count:', unreadError.message)

  const inbound: ParsedInbound = mediaUrl
    ? { kind: 'attachment', url: mediaUrl, mime_type: storedMime, message_id: messageId, meta_message_id: messageId }
    : replyId
      ? { kind: 'interactive_reply', reply_id: replyId, reply_title: replyTitle, meta_message_id: messageId, message_id: messageId }
      : { kind: 'text', text, meta_message_id: messageId, message_id: messageId }

  // O fluxo (e a IA, se o fluxo tiver o nó) responde depois da resposta
  // HTTP: o cliente vê a própria mensagem na hora e a resposta chega na
  // próxima busca.
  after(async () => {
    try {
      const flowResult = await dispatchInboundToFlows({
        accountId: session.account_id,
        userId: conversation.user_id,
        contactId: session.contact_id,
        conversationId,
        configId: session.config_id ?? undefined,
        message: inbound,
        isFirstInboundMessage: false,
      })
      // Sentimento (antes o Webchat nunca analisava).
      maybeScheduleSentiment(
        { accountId: session.account_id, contactId: session.contact_id, conversationId },
        { text, flowConsumed: flowResult.consumed, isInteractiveReply: Boolean(replyId) },
      )
    } catch (err) {
      console.error('[webchat/messages] falha ao entregar ao fluxo:', err)
    }
  })

  return webchatJson({ state: 'active', message: toClientMessage(token, inserted[0]) }, 201)
}
