import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'
import type { TemplateButton, TemplateSampleValues } from '@/types'

/**
 * Sync message templates from Meta → local message_templates table.
 *
 * The local catalog stores Meta's status enum verbatim (APPROVED /
 * PENDING / REJECTED / PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION)
 * so the edit / resubmit / delete flows can distinguish recoverable
 * states (PAUSED) from terminal ones (DISABLED) and so webhook events
 * land 1:1 without a translation table.
 *
 * Locally-created templates (no Meta counterpart) are NOT deleted —
 * they remain visible so the user can notice drift and clean up.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

interface MetaButton {
  type: string
  text: string
  url?: string
  phone_number?: string
  example?: string[] | string
}

interface MetaTemplateComponent {
  type: string
  text?: string
  format?: string
  buttons?: MetaButton[]
  example?: {
    header_text?: string[]
    header_handle?: string[]
    body_text?: string[][]
  }
}

interface MetaTemplate {
  id: string
  name: string
  language: string
  status: string
  category: string
  components?: MetaTemplateComponent[]
  quality_score?: { score?: string } | string
}

function normalizeCategory(
  meta: string,
): 'Marketing' | 'Utility' | 'Authentication' {
  const upper = meta.toUpperCase()
  if (upper === 'UTILITY') return 'Utility'
  if (upper === 'AUTHENTICATION') return 'Authentication'
  return 'Marketing'
}

function normalizeQualityScore(
  raw: MetaTemplate['quality_score'],
): 'GREEN' | 'YELLOW' | 'RED' | null {
  const score =
    typeof raw === 'string' ? raw : raw?.score ? String(raw.score) : null
  if (!score) return null
  const upper = score.toUpperCase()
  return upper === 'GREEN' || upper === 'YELLOW' || upper === 'RED'
    ? (upper as 'GREEN' | 'YELLOW' | 'RED')
    : null
}

function parseButtons(metaButtons: MetaButton[] | undefined): TemplateButton[] {
  if (!metaButtons?.length) return []
  const out: TemplateButton[] = []
  for (const b of metaButtons) {
    switch (b.type?.toUpperCase()) {
      case 'QUICK_REPLY':
        out.push({ type: 'QUICK_REPLY', text: b.text })
        break
      case 'URL':
        out.push({
          type: 'URL',
          text: b.text,
          url: b.url ?? '',
          example: Array.isArray(b.example) ? b.example[0] : b.example,
        })
        break
      case 'PHONE_NUMBER':
        out.push({
          type: 'PHONE_NUMBER',
          text: b.text,
          phone_number: b.phone_number ?? '',
        })
        break
      case 'COPY_CODE':
        out.push({
          type: 'COPY_CODE',
          text: b.text,
          example: Array.isArray(b.example) ? b.example[0] ?? '' : b.example ?? '',
        })
        break
      // OTP, FLOW, etc — out of scope for v1; drop silently.
    }
  }
  return out
}

function extractSampleValues(
  body: MetaTemplateComponent | undefined,
  header: MetaTemplateComponent | undefined,
): TemplateSampleValues | null {
  // Meta returns body_text as a 2D array — one row per example set.
  // We take the first row (most templates have exactly one).
  const bodySample = body?.example?.body_text?.[0]
  const headerSample = header?.example?.header_text
  if (!bodySample?.length && !headerSample?.length) return null
  const sv: TemplateSampleValues = {}
  if (bodySample?.length) sv.body = bodySample
  if (headerSample?.length) sv.header = headerSample
  return sv
}

export async function POST() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Resolve the caller's account_id — both whatsapp_config and
    // the message_templates we sync into are account-scoped.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Todos os canais Meta habilitados da conta, agrupados por WABA: cada
    // WABA tem o próprio catálogo de templates. Antes só o canal mais
    // antigo era lido e os templates das outras WABAs nunca chegavam ao
    // catálogo local (e a campanha não tinha como validar o template do
    // número escolhido).
    const { data: configs, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .eq('provider', 'meta')
      .eq('habilitado', true)
      .order('created_at', { ascending: true })

    if (configError || !configs || configs.length === 0) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
        },
        { status: 400 },
      )
    }

    // Um canal por WABA (o mais antigo) — o token de qualquer número da
    // WABA lê o catálogo inteiro dela.
    const configByWaba = new Map<string, (typeof configs)[number]>()
    for (const c of configs) {
      if (c.waba_id && !configByWaba.has(c.waba_id)) configByWaba.set(c.waba_id, c)
    }

    if (configByWaba.size === 0) {
      return NextResponse.json(
        {
          error:
            'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
        },
        { status: 400 },
      )
    }

    let total = 0
    let inserted = 0
    let updated = 0
    let truncated = false
    let wabaFailures = 0
    const errors: { name: string; language: string; message: string }[] = []

    for (const [wabaId, config] of configByWaba) {
      const fetched = await fetchWabaTemplates(wabaId, decrypt(config.access_token))
      if ('error' in fetched) {
        wabaFailures++
        errors.push({ name: `WABA ${wabaId}`, language: '-', message: fetched.error })
        continue
      }
      truncated = truncated || fetched.truncated
      total += fetched.templates.length

      for (const t of fetched.templates) {
        const result = await upsertSyncedTemplate(supabase, accountId, user.id, wabaId, t)
        if (result === 'inserted') inserted++
        else if (result === 'updated') updated++
        else errors.push({ name: t.name, language: t.language, message: result.error })
      }
    }

    // Nenhuma WABA respondeu: mesmo comportamento de antes (502 com o erro
    // da Meta), em vez de "0 templates sincronizados".
    if (wabaFailures === configByWaba.size) {
      return NextResponse.json({ error: errors[0]?.message ?? 'Meta API error' }, { status: 502 })
    }

    return NextResponse.json({
      success: errors.length === 0,
      total,
      inserted,
      updated,
      errors,
      truncated,
      wabas: configByWaba.size,
    })
  } catch (error) {
    console.error('Error syncing WhatsApp templates:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to sync templates',
      },
      { status: 500 },
    )
  }
}

const PAGE_CAP = 20

async function fetchWabaTemplates(
  wabaId: string,
  accessToken: string,
): Promise<{ templates: MetaTemplate[]; truncated: boolean } | { error: string }> {
  const templates: MetaTemplate[] = []
  let nextUrl:
    | string
    | null = `${META_API_BASE}/${wabaId}/message_templates?limit=100&fields=id,name,language,status,category,components,quality_score`
  let pageCount = 0

  while (nextUrl && pageCount < PAGE_CAP) {
    pageCount++
    const metaRes: Response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!metaRes.ok) {
      let metaErr = `Meta API error: ${metaRes.status}`
      try {
        const body = await metaRes.json()
        if (body?.error?.message) metaErr = body.error.message
      } catch {
        // response wasn't JSON — keep the fallback
      }
      return { error: metaErr }
    }

    const metaBody: {
      data?: MetaTemplate[]
      paging?: { next?: string }
    } = await metaRes.json()
    if (metaBody.data) templates.push(...metaBody.data)
    nextUrl = metaBody.paging?.next ?? null
  }
  return { templates, truncated: pageCount >= PAGE_CAP && nextUrl !== null }
}

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * Grava um template da Meta no catálogo local pela chave
 * (account_id, waba_id, name, language) — migration 160. O mesmo nome e
 * idioma em duas WABAs são duas linhas. Uma linha antiga sem waba_id
 * (sincronizada antes da 073) é adotada pela primeira WABA que a trouxer.
 */
async function upsertSyncedTemplate(
  supabase: SupabaseServerClient,
  accountId: string,
  userId: string,
  wabaId: string,
  t: MetaTemplate,
): Promise<'inserted' | 'updated' | { error: string }> {
  const body = (t.components ?? []).find((c) => c.type === 'BODY')
  const header = (t.components ?? []).find((c) => c.type === 'HEADER')
  const footer = (t.components ?? []).find((c) => c.type === 'FOOTER')
  const buttons = (t.components ?? []).find((c) => c.type === 'BUTTONS')

  const parsedButtons = parseButtons(buttons?.buttons)
  const sampleValues = extractSampleValues(body, header)

  const headerFormat = header?.format?.toUpperCase()
  const headerType =
    headerFormat === 'TEXT' ||
    headerFormat === 'IMAGE' ||
    headerFormat === 'VIDEO' ||
    headerFormat === 'DOCUMENT'
      ? headerFormat.toLowerCase()
      : null

  // Meta-sourced fields only — deliberately omits folder_id and
  // channel_tags. Both are local-only organization the user sets
  // via the folders UI; Meta has no concept of either, so a sync
  // must never touch them. On the UPDATE branch below, Supabase's
  // `.update(row)` only sets the columns present in `row` (a plain
  // PATCH body), so leaving them out here is what preserves the
  // existing values — do not "fill in" folder_id/channel_tags
  // here even to null.
  const row = {
    // Account tenancy + user audit, same split as the submit
    // route. account_id is NOT NULL on message_templates
    // post-017, so an INSERT without it errors.
    account_id: accountId,
    user_id: userId,
    name: t.name,
    category: normalizeCategory(t.category),
    language: t.language,
    header_type: headerType,
    header_content: header?.text ?? null,
    header_handle: header?.example?.header_handle?.[0] ?? null,
    body_text: body?.text ?? '',
    footer_text: footer?.text ?? null,
    buttons: parsedButtons.length ? parsedButtons : null,
    sample_values: sampleValues,
    status: normalizeStatus(t.status),
    meta_template_id: t.id,
    quality_score: normalizeQualityScore(t.quality_score),
    waba_id: wabaId,
    updated_at: new Date().toISOString(),
  }

  // waba_id vem de whatsapp_config (só dígitos) — seguro no filtro .or().
  const { data: candidates, error: lookupErr } = await supabase
    .from('message_templates')
    .select('id, waba_id')
    .eq('account_id', accountId)
    .eq('name', t.name)
    .eq('language', t.language)
    .or(`waba_id.eq.${wabaId},waba_id.is.null`)
  if (lookupErr) return { error: lookupErr.message }

  const rows = (candidates ?? []) as Array<{ id: string; waba_id: string | null }>
  const existing = rows.find((c) => c.waba_id === wabaId) ?? rows.find((c) => !c.waba_id)

  if (existing?.id) {
    const { error: updErr } = await supabase
      .from('message_templates')
      .update(row)
      .eq('id', existing.id)
    return updErr ? { error: updErr.message } : 'updated'
  }
  const { error: insErr } = await supabase.from('message_templates').insert(row)
  return insErr ? { error: insErr.message } : 'inserted'
}
