import {
  sendWahaTextMessage,
  sendWahaMediaMessage,
  type WahaSendResult,
} from '@/lib/whatsapp/waha-api'
import type { MediaKind } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Flows-side WAHA sender. Mirrors meta-send.ts's structure (resolve
// contact, resolve channel config, send, persist message, update
// conversation) — see that file for the pattern this follows.
//
// Differences from meta-send.ts, and why:
//   - No phone-variant retry loop. Meta rejects certain phone formats
//     depending on country/sandbox quirks, which is what that retry
//     loop works around; WAHA has no such rejection mode — its own
//     sendWahaTextMessage/sendWahaMediaMessage already normalize the
//     number into a chatId (`${digits}@c.us`) internally. Copying the
//     retry loop here would be solving a problem that doesn't exist
//     on this side.
//   - configId is REQUIRED, not optional. An account can have several
//     WAHA lines (migration 039's (account_id, waha_session) unique
//     index) — unlike Meta, there is no "the account's WAHA config"
//     fallback to fall back to, so the caller (engine.ts) must always
//     know which line a run is bound to.
//   - No interactive button/list support in WAHA (confirmed: no such
//     function exists in waha-api.ts). engineWahaSendButtons /
//     engineWahaSendList fake it as a numbered plain-text list and
//     return a { "1": reply_id, ... } map for the caller to persist
//     on flow_runs.vars.__waha_button_map, which the engine consults
//     on the customer's next text reply (see engine.ts's
//     handleReplyForActiveRun).
// ------------------------------------------------------------

async function resolveContactPhone(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  contactId: string,
): Promise<string> {
  const { data: contact, error } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !contact?.phone) {
    throw new Error('contact not found for this account')
  }
  return contact.phone as string
}

async function resolveWahaConfig(
  db: ReturnType<typeof supabaseAdmin>,
  configId: string,
): Promise<{ waha_url: string; waha_session: string; waha_api_key: string | null }> {
  const { data: config, error } = await db
    .from('whatsapp_config')
    .select('waha_url, waha_session, waha_api_key')
    .eq('id', configId)
    .single()
  if (error || !config) {
    throw new Error('WAHA channel not found')
  }
  return {
    waha_url: config.waha_url as string,
    waha_session: config.waha_session as string,
    waha_api_key: config.waha_api_key ? decrypt(config.waha_api_key as string) : null,
  }
}

async function persistOutgoing(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    conversationId: string
    contentType: string
    contentText: string | null
    messageId: string
    wahaSession: string
    previewText: string
  },
): Promise<void> {
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.contentType,
    content_text: args.contentText,
    message_id: args.messageId,
    status: 'sent',
    waha_session: args.wahaSession,
  })
  if (msgErr) {
    throw new Error(`sent to WAHA but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: args.previewText,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)
}

interface WahaSendTextEngineArgs {
  accountId: string
  /** wacrm.whatsapp_config.id — required, see the header note. */
  configId: string
  conversationId: string
  contactId: string
  text: string
}

/**
 * Send a plain-text WhatsApp message via WAHA from the Flows engine.
 * Used by send_message / collect_input, and internally by
 * engineWahaSendButtons / engineWahaSendList (both are plain text on
 * the wire — see header note).
 */
export async function engineWahaSendText(
  args: WahaSendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()
  const phone = await resolveContactPhone(db, args.accountId, args.contactId)
  const wahaConfig = await resolveWahaConfig(db, args.configId)

  const result: WahaSendResult = await sendWahaTextMessage(wahaConfig, phone, args.text)

  await persistOutgoing(db, {
    conversationId: args.conversationId,
    contentType: 'text',
    contentText: args.text,
    messageId: result.messageId,
    wahaSession: wahaConfig.waha_session,
    previewText: args.text,
  })

  return { whatsapp_message_id: result.messageId }
}

interface WahaSendMediaEngineArgs {
  accountId: string
  configId: string
  conversationId: string
  contactId: string
  mediaUrl: string
  caption?: string
}

/** Best-effort content_type from the URL's extension — sendWahaMediaMessage
 *  itself never reads its `mediaType` param (WAHA's /api/sendFile infers
 *  the type from the file), so this only decides what we persist locally. */
function guessMediaKind(url: string): MediaKind {
  const ext = (url.split('?')[0].split('.').pop() ?? '').toLowerCase()
  if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image'
  if (['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext)) return 'video'
  if (['mp3', 'ogg', 'oga', 'wav', 'm4a', 'aac'].includes(ext)) return 'audio'
  return 'document'
}

/**
 * Send an image / video / document via WAHA from the Flows engine.
 * Used by the runner's send_media node.
 */
export async function engineWahaSendMedia(
  args: WahaSendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()
  const phone = await resolveContactPhone(db, args.accountId, args.contactId)
  const wahaConfig = await resolveWahaConfig(db, args.configId)

  const kind = guessMediaKind(args.mediaUrl)
  const filename = args.mediaUrl.split('?')[0].split('/').pop() || `file_${Date.now()}`

  const result: WahaSendResult = await sendWahaMediaMessage(
    wahaConfig,
    phone,
    args.mediaUrl,
    kind,
    filename,
    args.caption,
  )

  const preview = args.caption?.trim() || `[${kind}]`
  await persistOutgoing(db, {
    conversationId: args.conversationId,
    contentType: kind,
    contentText: args.caption ?? null,
    messageId: result.messageId,
    wahaSession: wahaConfig.waha_session,
    previewText: preview,
  })

  return { whatsapp_message_id: result.messageId }
}

interface WahaButtonInput {
  id: string
  title: string
}

interface WahaSendButtonsEngineArgs {
  accountId: string
  configId: string
  conversationId: string
  contactId: string
  body: string
  buttons: WahaButtonInput[]
}

/**
 * "Buttons" over WAHA: there's no native interactive message, so this
 * sends a numbered plain-text list ("1. Option A\n2. Option B") and
 * returns a { "1": button.id, ... } map. The caller (engine.ts)
 * persists this on flow_runs.vars.__waha_button_map so the customer's
 * next numeric text reply can be matched back to the button's
 * reply_id, the same way a real interactive tap would be.
 */
export async function engineWahaSendButtons(
  args: WahaSendButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string; buttonMap: Record<string, string> }> {
  const buttonMap: Record<string, string> = {}
  const lines = args.buttons.map((b, i) => {
    const key = String(i + 1)
    buttonMap[key] = b.id
    return `${key}. ${b.title}`
  })
  const text = `${args.body}\n\n${lines.join('\n')}\n\nDigite o número da opção desejada.`

  const { whatsapp_message_id } = await engineWahaSendText({
    accountId: args.accountId,
    configId: args.configId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    text,
  })

  return { whatsapp_message_id, buttonMap }
}

interface WahaListRow {
  id: string
  title: string
  description?: string
}

interface WahaListSection {
  title?: string
  rows: WahaListRow[]
}

interface WahaSendListEngineArgs {
  accountId: string
  configId: string
  conversationId: string
  contactId: string
  body: string
  sections: WahaListSection[]
}

/**
 * "List" over WAHA: same numbered-plain-text approach as
 * engineWahaSendButtons, flattening every section's rows into one
 * continuously-numbered list (section titles rendered as bold
 * headers, not counted). Numbering is global across sections so the
 * customer picks one number regardless of which section it's under.
 */
export async function engineWahaSendList(
  args: WahaSendListEngineArgs,
): Promise<{ whatsapp_message_id: string; buttonMap: Record<string, string> }> {
  const buttonMap: Record<string, string> = {}
  const lines: string[] = []
  let counter = 0
  for (const section of args.sections) {
    if (section.title) lines.push(`*${section.title}*`)
    for (const row of section.rows) {
      counter += 1
      const key = String(counter)
      buttonMap[key] = row.id
      lines.push(`${key}. ${row.title}${row.description ? ` — ${row.description}` : ''}`)
    }
  }
  const text = `${args.body}\n\n${lines.join('\n')}\n\nDigite o número da opção desejada.`

  const { whatsapp_message_id } = await engineWahaSendText({
    accountId: args.accountId,
    configId: args.configId,
    conversationId: args.conversationId,
    contactId: args.contactId,
    text,
  })

  return { whatsapp_message_id, buttonMap }
}
