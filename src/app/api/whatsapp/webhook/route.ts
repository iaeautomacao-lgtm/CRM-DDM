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
  drainStatusInbox,
  extractStatusEvents,
  ingestStatusEvents,
  MAX_WEBHOOK_BODY_BYTES,
} from '@/lib/whatsapp/status-inbox'
import {
  allowExpensiveRejection,
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
import { handleChannelHealthChange, isChannelHealthField } from '@/lib/disparador/channel-health'
import { processMessage, type WhatsAppMessage } from '@/lib/whatsapp/inbound-message'
import { extractMessageEvents, ingestMessageEvents, messageInboxMode } from '@/lib/whatsapp/message-inbox'
import { drainMessageInboxLive } from '@/lib/whatsapp/message-inbox-runner'

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
  // Teto de corpo (~1 MB): os POSTs da Meta são pequenos; recusa antes de ler/parsear.
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text()
  if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }
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
        // Eventos de WABA (template e saúde do número) não trazem metadata.phone_number_id: chave "waba:<entry.id>".
        isTemplateWebhookField(change?.field) || isChannelHealthField(change?.field),
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
    // W4: log (INSERT em system_logs) amostrado — no máx. 1× por janela e por conjunto de canais.
    if (allowExpensiveRejection(`log:${rejectedKeys.join(',')}`)) {
      void writeLog({
        level: 'warn',
        source: 'webhook_meta',
        event: 'hmac_rejected',
        message: 'Assinatura HMAC inválida rejeitada no webhook Meta',
        // Identificadores de canal Meta (phone_number_id/WABA), não telefone de
        // contato — não precisam de mascaramento (ver maskPhone).
        payload: { channels: rejectedKeys },
      })
    }
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
  // Status delivered/read/failed: gravados no inbox DURÁVEL antes do 200 (uma chamada por POST).
  // Se a gravação falhar, responde 500 e a Meta reenvia (antes: o erro era engolido e o recibo se perdia).
  // Migration 185 ausente ⇒ caminho antigo (3 chamadas por evento depois do 200).
  let statusesIngested = false
  const statusEvents = extractStatusEvents(body, verifiedChannels, (entry, change) =>
    channelKeyForChange(entry, change, isTemplateWebhookField(change?.field ?? "")),
  )
  if (statusEvents.length > 0) {
    const ingest = await ingestStatusEvents(supabaseAdmin(), statusEvents)
    if (ingest.ok) {
      statusesIngested = true
    } else if (!ingest.missing) {
      console.error('[webhook] falha ao gravar o lote de status; a Meta vai reenviar:', ingest.error)
      return NextResponse.json({ error: 'Status ingestion failed' }, { status: 500 })
    }
  }

  // Mensagens do cliente: inbox DURÁVEL (migration 201), mesmo princípio dos status. Modo por
  // WHATSAPP_MESSAGE_INBOX (flag temporária de implantação — ver message-inbox.ts):
  //   off    → como sempre (processa em after(), sem rede de segurança);
  //   shadow → grava no inbox E processa como sempre; o cron só compara (mede o que seria perdido);
  //   on     → grava ANTES do 200 (falhou ⇒ 500, a Meta reenvia) e o drenador processa a partir do inbox.
  // Migration 201 ausente ⇒ caminho antigo, sem 500.
  const inboxMode = messageInboxMode()
  let messagesIngested = false
  let ownMessageIds: number[] = []
  if (inboxMode !== 'off') {
    const messageEvents = extractMessageEvents(body, verifiedChannels, (entry, change) =>
      channelKeyForChange(entry, change, isTemplateWebhookField(change?.field ?? "")),
    )
    if (messageEvents.length > 0) {
      const ingest = await ingestMessageEvents(supabaseAdmin(), messageEvents, inboxMode === 'on' ? 'pending' : 'shadow')
      if (ingest.ok) {
        if (inboxMode === 'on') {
          messagesIngested = true
          ownMessageIds = ingest.ids
        }
      } else if (!ingest.missing) {
        if (inboxMode === 'on') {
          console.error('[webhook] falha ao gravar o lote de mensagens; a Meta vai reenviar:', ingest.error)
          return NextResponse.json({ error: 'Message ingestion failed' }, { status: 500 })
        }
        // shadow: o caminho antigo é a fonte da verdade; falha do espelho só é registrada.
        console.error('[webhook] shadow: falha ao gravar o lote de mensagens no inbox:', ingest.error)
      }
    }
  }

  after(async () => {
    // Drenar os inboxes e processar o resto do corpo são independentes: um não derruba o outro.
    await Promise.allSettled([
      (async () => {
        try {
          await processWebhook(body, verifiedChannels, { statusesIngested, messagesIngested })
        } catch (error) {
          console.error('Error processing webhook:', error)
        }
      })(),
      statusesIngested ? drainStatusInbox(supabaseAdmin(), { requireTurn: true }) : Promise.resolve(),
      messagesIngested
        ? drainMessageInboxLive(supabaseAdmin(), { ids: ownMessageIds, requireTurn: true })
        : Promise.resolve(),
    ])
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
  // W4: relê o banco no máximo 1× por janela por canal (rotação legítima corrige na 1ª tentativa; uma
  // rajada de assinaturas inválidas não vira uma rajada de SELECTs).
  if (!result.ok && result.fromCache && allowExpensiveRejection(`recheck:${key}`)) {
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
  options: { statusesIngested?: boolean; messagesIngested?: boolean } = {},
) {
  if (!body.entry) return

  for (const entry of body.entry) {
    for (const change of entry.changes) {
      const isTemplate = isTemplateWebhookField(change.field)
      const isHealth = isChannelHealthField(change.field)
      // Só processa o que pertence a um canal cuja assinatura validou; a
      // conta usada em tudo abaixo vem DESSE canal, nunca do conteúdo do corpo.
      const channelKey = channelKeyForChange(entry, change, isTemplate || isHealth)
      const channel = channelKey ? verifiedChannels.get(channelKey) : undefined
      if (!channel) {
        console.warn('[webhook] change ignorada: canal não validado:', channelKey)
        continue
      }

      // Saúde do número (phone_number_quality_update / account_update): re-consulta o Graph e recalcula o limite/s (P1-5).
      // Falha aqui nunca derruba o restante do POST (a Meta não reenvia: já recebeu 200).
      if (isHealth) {
        try {
          await handleChannelHealthChange(supabaseAdmin(), {
            wabaId: String(entry.id),
            accountId: channel.account_id,
            field: change.field,
            value: change.value as unknown as Record<string, unknown>,
          })
        } catch (error) {
          console.error('[webhook] falha ao tratar evento de saúde do número:', change.field, error)
        }
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
      // (statusesIngested: delivered/read/failed já estão no inbox durável e são aplicados em lote.)
      if (value.statuses && !options.statusesIngested) {
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
      // (messagesIngested: já estão no inbox durável e o drenador as processa — migration 201.)
      if (!value.messages || !value.contacts || options.messagesIngested) continue

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

        // Uma mensagem que falha não derruba as demais do mesmo POST (a Meta não reenvia: já recebeu 200).
        try {
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
        } catch (error) {
          console.error('[webhook] falha ao processar mensagem:', message.id, error)
          void writeLog({
            account_id: config.account_id,
            level: 'error',
            source: 'webhook_meta',
            event: 'inbound_message_failed',
            message: 'Falha ao gravar/processar mensagem recebida da Meta (caminho inline)',
            payload: { message_id: message.id, erro: error instanceof Error ? error.message : String(error) },
          })
        }
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
