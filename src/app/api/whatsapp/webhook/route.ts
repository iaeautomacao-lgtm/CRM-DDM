import { chatMediaReference } from '@/lib/storage/chat-media';
import { auditFetch, registerAuditActor } from '@/lib/audit/context'
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  decrypt,
  decryptStoredSecret,
  encrypt,
  isEncryptedSecret,
  isLegacyCbcSecret,
} from '@/lib/whatsapp/encryption'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { maybeScheduleSentiment } from '@/lib/ai/sentiment-trigger'
import { reopenConversationFields } from '@/lib/conversations/reopen'
import { recordCampaignReply } from '@/lib/disparador/reply-tracker'
import { maybeStartCampaignWebchat } from '@/lib/webchat/campaign'
import { writeLog, maskPhone } from '@/lib/logger'
import {
  cacheChannel,
  channelKeyForChange,
  getCachedChannel,
  invalidateChannel,
  processStatusesIndependently,
  type ChannelRow,
} from '@/lib/whatsapp/webhook-fast-path'
import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from '@/lib/whatsapp/template-webhook'

// The `after()` callback in POST runs within this route's max duration.
// Inbound processing can fan out to per-media Meta verification calls, so
// give it headroom beyond the platform default (Vercel clamps this to the
// plan's ceiling). Tune as needed.
export const maxDuration = 60

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

interface WhatsAppMessage {
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

interface WhatsAppWebhookEntry {
  id: string
  changes: Array<{
    value: {
      messaging_product: string
      metadata: {
        display_phone_number: string
        phone_number_id: string
      }
      contacts?: Array<{
        profile: { name: string }
        wa_id: string
      }>
      messages?: WhatsAppMessage[]
      statuses?: Array<{
        id: string
        status: string
        timestamp: string
        recipient_id: string
      }>
    }
    field: string
  }>
}

// GET - Webhook verification
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 }
      )
    }

    // Fetch all whatsapp configs to check verify tokens
    const { data: configs, error: configError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('id, verify_token')

    if (configError || !configs) {
      console.error('Error fetching configs for verification:', configError)
      return NextResponse.json(
        { error: 'Verification failed' },
        { status: 403 }
      )
    }

    // Check if any config's verify_token matches. Also collect the
    // matching row so we can opportunistically upgrade its token to
    // GCM if it was still in the legacy CBC format.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let matchedConfig: any = null
    for (const config of configs) {
      if (!config.verify_token) continue
      try {
        if (
          decryptStoredSecret(config.verify_token, 'whatsapp_config.verify_token') ===
          verifyToken
        ) {
          matchedConfig = config
          break
        }
      } catch {
        // Malformed / wrong-key token row — skip it and keep checking.
      }
    }

    if (matchedConfig) {
      // Fire-and-forget GCM upgrade. Safe to run on every subscribe
      // since it's a no-op once the column is already GCM.
      // Também cobre texto puro legado — qualquer coisa fora do formato GCM.
      if (!isEncryptedSecret(matchedConfig.verify_token)) {
        void supabaseAdmin()
          .from('whatsapp_config')
          .update({ verify_token: encrypt(verifyToken) })
          .eq('id', matchedConfig.id)
          .then(({ error }: { error: unknown }) => {
            if (error) {
              console.warn(
                '[webhook] verify_token GCM upgrade failed:',
                (error as { message?: string })?.message ?? error
              )
            }
          })
      }
      // Return challenge as plain text
      return new Response(challenge, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    return NextResponse.json(
      { error: 'Verification token mismatch' },
      { status: 403 }
    )
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST - Receive messages
export async function POST(request: Request) {
  // Auditoria: escritas desta requisição saem como "webhook" (webhook_meta_whatsapp).
  await registerAuditActor({ actorType: 'webhook', source: 'webhook_meta_whatsapp' })
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // C-2 (auditoria): a assinatura é validada POR CANAL. Cada change só é
  // processada se o seu phone_number_id (ou, para eventos de template, o WABA
  // da entry) pertence a um whatsapp_config cujo app_secret valida o HMAC do
  // corpo. Antes, só o entry[0] era conferido e todo o resto era processado:
  // quem tinha um App Meta próprio assinava com o próprio segredo e injetava
  // eventos em números de OUTRAS contas.
  const channelKeys = new Set<string>()
  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const key = channelKeyForChange(
        entry,
        change,
        isTemplateWebhookField(change?.field),
      )
      if (key) channelKeys.add(key)
    }
  }

  const verifiedChannels = new Map<string, ChannelRow>()
  const rejectedKeys: string[] = []
  let anyMissingSecret = false
  if (channelKeys.size === 0) {
    // Corpo sem canal identificável: nada será processado; só vale validar a
    // assinatura com o segredo global (comportamento anterior sem phone_number_id).
    const globalOnly = verifyWithGlobalSecret(rawBody, signature)
    if (globalOnly === 'no_secret') anyMissingSecret = true
    if (globalOnly !== 'ok') rejectedKeys.push('(sem canal)')
  }
  for (const key of channelKeys) {
    const result = await verifyChannelKey(key, rawBody, signature)
    if (result.ok && result.row) {
      verifiedChannels.set(key, result.row)
    } else if (!result.ok) {
      rejectedKeys.push(key)
      if (result.noSecret) anyMissingSecret = true
    }
    // ok sem row: assinado pelo segredo global, mas canal sem whatsapp_config
    // — não há conta para escopar, então não há o que processar.
  }
  // 401 só quando NADA do corpo validou; corpo misto segue com o que validou.
  const anyValid =
    verifiedChannels.size > 0 ||
    (channelKeys.size > 0 && rejectedKeys.length < channelKeys.size)
  const signatureOk = channelKeys.size === 0 ? rejectedKeys.length === 0 : anyValid

  if (!signatureOk && anyMissingSecret) {
    console.error(
      '[webhook] no App Secret configured for channels:',
      rejectedKeys
    )
    return NextResponse.json(
      { error: 'App Secret não configurado para este canal' },
      { status: 401 }
    )
  }

  if (!signatureOk) {
    // 401 (not 200) — we want Meta's delivery dashboard to show failures
    // loudly if a misconfiguration causes signatures to stop matching,
    // rather than silently eating events.
    console.warn('[webhook] rejected request with invalid signature')
    // Fire-and-forget — não faz sentido atrasar a resposta 401 pra Meta
    // esperando o insert do log.
    void writeLog({
      level: 'warn',
      source: 'webhook_meta',
      event: 'hmac_rejected',
      message: 'Assinatura HMAC inválida rejeitada no webhook Meta',
      // Identificadores de canal Meta (phone_number_id/WABA), não telefone de
      // contato — não precisam de mascaramento (ver maskPhone).
      payload: { channels: rejectedKeys },
    })
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  if (rejectedKeys.length > 0) {
    // Corpo misto: o que não bate com o segredo do seu próprio canal é
    // descartado (tentativa de injeção cross-tenant), o resto segue.
    console.warn('[webhook] canais descartados por assinatura inválida:', rejectedKeys)
    void writeLog({
      level: 'warn',
      source: 'webhook_meta',
      event: 'hmac_partial_rejected',
      message: 'Canais do POST descartados: assinatura não confere com o app_secret do canal',
      payload: { channels: rejectedKeys },
    })
  }

  // Process AFTER the response so we ack Meta within their ~20s timeout
  // (a slow ack triggers Meta retries + duplicate inserts), while still
  // guaranteeing the work runs to completion.
  //
  // This MUST use `after()` rather than a detached `processWebhook(body)`
  // promise: on serverless platforms (we run on Vercel) the function can
  // be frozen or terminated the moment the response is sent, so a floating
  // promise's DB writes are not guaranteed to finish. That dropped a
  // non-deterministic *subset* of inbound messages — contacts/conversations
  // were created but the message insert never landed, leaving conversations
  // that show in the inbox with an empty thread, and no logs to explain it
  // (see issue #301). `after()` hands the callback to the runtime, which
  // keeps the function alive until it resolves (within the route's
  // maxDuration).
  after(async () => {
    try {
      await processWebhook(body, verifiedChannels)
    } catch (error) {
      console.error('Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

type VerifyOutcome =
  | { ok: true; row: ChannelRow | null }
  | { ok: false; row: ChannelRow | null; noSecret: boolean }

function verifyWithGlobalSecret(
  rawBody: string,
  signature: string | null,
): 'ok' | 'bad' | 'no_secret' {
  const globalAppSecret = process.env.META_APP_SECRET
  if (!globalAppSecret) return 'no_secret'
  return verifyMetaWebhookSignature(rawBody, signature, globalAppSecret)
    ? 'ok'
    : 'bad'
}

async function resolveChannel(
  key: string,
  useCache: boolean,
): Promise<{ row: ChannelRow | null; fromCache: boolean }> {
  if (useCache) {
    const cached = getCachedChannel(key)
    if (cached) return { row: cached, fromCache: true }
  }
  const column = key.startsWith('waba:') ? 'waba_id' : 'phone_number_id'
  const { data: config } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, account_id, app_secret')
    .eq(column, key.slice(key.indexOf(':') + 1))
    .eq('provider', 'meta')
    .limit(1)
    .single()
  if (!config?.id || !config?.account_id) return { row: null, fromCache: false }
  const row: ChannelRow = {
    id: config.id,
    account_id: config.account_id,
    app_secret: config.app_secret ?? null,
  }
  cacheChannel(key, row)
  return { row, fromCache: false }
}

// Valida o HMAC do corpo contra o app_secret do canal `key`. O canal fica em
// cache (TTL curto): evita 1 ida ao banco antes do 200. Se a assinatura não
// conferir com o canal vindo do cache (ex.: secret rotacionado há <60s), relê
// o banco uma vez antes de rejeitar.
async function verifyChannelKey(
  key: string,
  rawBody: string,
  signature: string | null,
): Promise<VerifyOutcome> {
  const attempt = async (useCache: boolean) => {
    const { row, fromCache } = await resolveChannel(key, useCache)
    let channelAppSecret: string | null = null
    let channelSecretIsLegacyPlaintext = false
    if (row?.app_secret) {
      channelSecretIsLegacyPlaintext =
        !isEncryptedSecret(row.app_secret) && !isLegacyCbcSecret(row.app_secret)
      try {
        // decryptStoredSecret aceita texto puro legado (gravado direto no
        // banco antes da correção) até o script de migração rodar — antes,
        // o decrypt() lançava e o webhook caía calado no META_APP_SECRET.
        channelAppSecret = decryptStoredSecret(
          row.app_secret,
          'whatsapp_config.app_secret',
        )
      } catch (err) {
        console.error('[webhook] failed to decrypt app_secret for channel:', key, err)
      }
    }

    // Fall back to the global env var for channels saved before app_secret
    // was captured per-config.
    const globalAppSecret = process.env.META_APP_SECRET
    const secret = channelAppSecret ?? globalAppSecret ?? null
    if (!secret) return { row, fromCache, ok: false, noSecret: true }

    let ok = verifyMetaWebhookSignature(rawBody, signature, secret)
    // Transição: antes, um app_secret em texto puro fazia o decrypt() lançar
    // e o webhook validava com o META_APP_SECRET global. Para não derrubar
    // um canal cujo valor legado esteja desatualizado, mantém esse fallback
    // SÓ para app_secret legado em texto puro, até o script de migração rodar.
    if (
      !ok &&
      channelSecretIsLegacyPlaintext &&
      globalAppSecret &&
      globalAppSecret !== secret
    ) {
      ok = verifyMetaWebhookSignature(rawBody, signature, globalAppSecret)
      if (ok) {
        console.warn(
          '[webhook] app_secret legado em texto puro não confere; assinatura validada pelo META_APP_SECRET global. canal:',
          key
        )
      }
    }
    return { row, fromCache, ok, noSecret: false }
  }

  let result = await attempt(true)
  if (!result.ok && result.fromCache) {
    invalidateChannel(key)
    result = await attempt(false)
  }
  return result.ok
    ? { ok: true, row: result.row }
    : { ok: false, row: result.row, noSecret: result.noSecret }
}

async function processWebhook(
  body: { entry?: WhatsAppWebhookEntry[] },
  verifiedChannels: Map<string, ChannelRow>,
) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      const isTemplate = isTemplateWebhookField(change.field)
      // Só processa o que pertence a um canal cuja assinatura validou; a
      // conta usada em tudo abaixo vem DESSE canal, nunca do conteúdo do corpo.
      const channelKey = channelKeyForChange(entry, change, isTemplate)
      const channel = channelKey ? verifiedChannels.get(channelKey) : undefined
      if (!channel) {
        console.warn('[webhook] change ignorada: canal não validado:', channelKey)
        continue
      }

      // Template-lifecycle events (status / quality / components
      // updates from Meta) come in on a different change.field and
      // have a different value shape — route them through the
      // dedicated handler. Skip the messaging branches below so we
      // don't try to read message-shaped fields off a template event.
      if (isTemplate) {
        await handleTemplateWebhookChange(
          { field: change.field, value: change.value as unknown },
          supabaseAdmin(),
          { accountId: channel.account_id }
        )
        continue
      }

      const value = change.value

      // Handle status updates
      if (value.statuses) {
        // Um status que falha não descarta os demais do mesmo POST (a Meta
        // não reenvia: já recebeu 200). 'sent' é ignorado — não agrega.
        await processStatusesIndependently(
          value.statuses,
          (status) => handleStatusUpdate(status, channel.account_id),
          (status, error) => {
            console.error('[webhook] falha ao processar status:', status.id, status.status, error)
            void writeLog({
              level: 'error',
              source: 'webhook_meta',
              event: 'status_update_failed',
              message: 'Falha ao processar status de mensagem da Meta',
              payload: {
                message_id: status.id,
                status: status.status,
                erro: error instanceof Error ? error.message : String(error),
              },
            })
          },
        )
      }

      // Handle incoming messages
      if (!value.messages || !value.contacts) continue

      const phoneNumberId = value.metadata.phone_number_id

      // Find user's config by phone_number_id. `.single()` returns
      // PGRST116 for both 0 rows AND ≥2 rows — distinguish them so
      // operators see the real cause in logs. ≥2 rows shouldn't happen
      // post-migration 013 (UNIQUE constraint), but a row created
      // before the constraint, or a race, would still surface here.
      const { data: configRows, error: configError } = await supabaseAdmin()
        .from('whatsapp_config')
        .select('*')
        .eq('phone_number_id', phoneNumberId)

      if (configError) {
        console.error(
          'Error fetching whatsapp_config for phone_number_id:',
          phoneNumberId,
          configError
        )
        continue
      }

      if (!configRows || configRows.length === 0) {
        console.error('No config found for phone_number_id:', phoneNumberId)
        continue
      }

      if (configRows.length > 1) {
        console.error(
          `Multiple configs (${configRows.length}) found for phone_number_id:`,
          phoneNumberId,
          '— inbound message dropped. Resolve duplicates so each number maps to a single account.',
          'Account owners:',
          configRows.map(
            (r: { account_id: string; user_id: string }) =>
              `${r.account_id} (admin ${r.user_id})`
          )
        )
        continue
      }

      const config = configRows[0]

      // Defesa em profundidade: o config usado para processar tem de ser o
      // mesmo canal cuja assinatura validou.
      if (config.id !== channel.id) {
        console.error('[webhook] config divergente do canal validado:', phoneNumberId)
        continue
      }

      const decryptedAccessToken = decrypt(config.access_token)

      for (let i = 0; i < value.messages.length; i++) {
        const message = value.messages[i]
        const contact = value.contacts[i] || value.contacts[0]

        await processMessage(
          message,
          contact,
          // Tenancy — drives every contact / conversation lookup
          // and the engines' active-row dispatch.
          config.account_id,
          // Audit / sender-of-record — used as the user_id on row
          // inserts that need it for NOT NULL FK compliance. Always
          // the admin who saved the WhatsApp config.
          config.user_id,
          decryptedAccessToken,
          config.id
        )
      }
    }
  }
}

async function handleStatusUpdate(
  status: {
    id: string
    status: string
    timestamp: string
    recipient_id: string
  },
  // Conta do canal cuja assinatura validou o POST — o update de `messages`
  // só alcança mensagens de conversas dessa conta.
  accountId: string
) {
  // Transições permitidas por status recebido da Meta. Os webhooks de
  // status podem chegar fora de ordem ou duplicados; só avançamos a partir
  // dos estados listados, então um 'sent' atrasado nunca rebaixa 'read'.
  const allowedPrevious: Record<string, string[]> = {
    sent: ['pending', 'sending'],
    // 'failed' → delivered/read: a Meta pode mandar failed (131026, aparelho
    // offline) e depois delivered/read para o mesmo wamid. 'failed' nunca
    // rebaixa delivered/read (ver `failed` abaixo). A tabela messages não tem
    // coluna de erro, então só o status muda.
    delivered: ['pending', 'sending', 'sent', 'failed'],
    read: ['pending', 'sending', 'sent', 'delivered', 'failed'],
    failed: ['pending', 'sending', 'sent'],
  }
  if (!allowedPrevious[status.status]) return
  // messages não tem account_id: resolve as linhas da conta via conversa e
  // atualiza por id (um status de outro canal nunca altera mensagem alheia).
  const { data: ownedMsgs, error: ownedErr } = await supabaseAdmin()
    .from('messages')
    .select('id, conversations!inner(account_id)')
    .eq('message_id', status.id)
    .eq('conversations.account_id', accountId)
  if (ownedErr) throw ownedErr
  const ownedIds = ((ownedMsgs ?? []) as Array<{ id: string }>).map((m) => m.id)
  if (ownedIds.length > 0) {
    const { error: msgErr } = await supabaseAdmin()
      .from('messages')
      .update({ status: status.status })
      .in('id', ownedIds)
      .in('status', allowedPrevious[status.status])
    if (msgErr) throw msgErr
  }

  const errors = (
    status as typeof status & {
      errors?: Array<{ code: number; title: string }>
    }
  ).errors
  const failureReason = errors?.[0]
    ? `Meta: ${errors[0].title} (code ${errors[0].code})`
    : null
  // Espelha o status na fila do disparador (migrations 119/125), numa
  // transação com lock do item. Se o recibo chegar antes da confirmação
  // local do envio (item ainda 'enviando'), ele fica guardado em
  // dispatch_status_receipts e é reaplicado depois — sem perder métricas.
  // Um 'failed' assíncrono marca erro permanente para revisão; nunca
  // reabre o item para novo envio automático.
  const { error: transitionError } = await supabaseAdmin().rpc(
    'apply_dispatch_status',
    {
      p_message_id: status.id,
      p_status: status.status,
      p_error: failureReason,
    }
  )
  if (transitionError) throw transitionError

  // ── Channel-test tracking ─────────────────────────────────────────
  // Mirror status into whatsapp_test_sends for one-off "Testar canal"
  // sends (channel-test/route.ts) — those deliberately have no
  // conversation/messages row, so the dialog polls this side table
  // instead. Unconditional update: matches 0 rows (silently, no error)
  // for every non-test-send status event, which is the common case.
  //
  // Precedência sent < delivered < read: a Meta pode mandar `failed` (ex.:
  // 131026) E `read` para o mesmo wamid, em qualquer ordem. `failed` nunca
  // sobrescreve delivered/read; delivered/read substituem um failed anterior
  // e limpam o erro. Update condicional no banco (sem read-modify-write).
  const testSendUpdate: Record<string, unknown> = { status: status.status }
  let testSendQuery = supabaseAdmin()
    .from('whatsapp_test_sends')
    .update(testSendUpdate)
    .eq('message_id', status.id)
  if (status.status === 'failed') {
    const metaErrors = (status as any).errors as
      | Array<{ code: number; title: string }>
      | undefined
    testSendUpdate.erro =
      metaErrors && metaErrors.length > 0
        ? `Meta: ${metaErrors[0].title} (code ${metaErrors[0].code})`
        : 'Falha na entrega (Meta)'
    testSendQuery = testSendQuery.not('status', 'in', '(delivered,read)')
  } else if (status.status === 'delivered') {
    testSendUpdate.erro = null
    testSendQuery = testSendQuery.in('status', ['sent', 'failed'])
  } else if (status.status === 'read') {
    testSendUpdate.erro = null
    testSendQuery = testSendQuery.in('status', ['sent', 'delivered', 'failed'])
  } else {
    // 'sent' atrasado nunca rebaixa delivered/read/failed.
    testSendQuery = testSendQuery.eq('status', 'sent')
  }
  const { error: testSendErr } = await testSendQuery
  if (testSendErr) {
    console.error('Error updating whatsapp_test_sends status:', testSendErr)
  }
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

async function processMessage(
  message: WhatsAppMessage,
  contact: { profile: { name: string }; wa_id: string },
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
) {
  const senderPhone = normalizePhone(message.from)
  const contactName = contact.profile.name

  // Find or create contact
  const contactOutcome = await findOrCreateContact(
    accountId,
    configOwnerUserId,
    senderPhone,
    contactName
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  // Find or create conversation
  const conversation = await findOrCreateConversation(
    accountId,
    configOwnerUserId,
    contactRecord.id,
    configId
  )
  if (!conversation) return

  // Reactions short-circuit here — they aren't messages. We never insert
  // into `messages`, never bump unread_count, never update last_message_text.
  // Done before parseMessageContent so the media-URL fetch is skipped.
  if (message.type === 'reaction') {
    await handleReaction(message, conversation.id, contactRecord.id)
    return
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
      return
    }
    console.error('Error inserting message:', msgError)
    return
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

    // Auto-tag "Acordo Realizado" when the AI detects a formalized agreement
    const { autoTagAcordoRealizado } = await import('@/lib/ai/acordo-tagging')
    void autoTagAcordoRealizado(accountId, contactRecord.id, conversation.id)
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
