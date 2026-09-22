import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { submitMessageTemplate } from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'

/**
 * Shared upsert payload builder — both the Meta-failure path and the
 * Meta-success path write nearly identical rows; dropping the shared
 * fields here means adding a column later only touches one spot.
 */
function buildUpsertRow(
  accountId: string,
  userId: string,
  payload: TemplatePayload,
  extras: {
    status: 'DRAFT' | string
    metaTemplateId: string | null
    submissionError: string | null
    wabaId: string | null
  },
) {
  return {
    // Account tenancy — required NOT NULL on message_templates as
    // of migration 017. Without this an INSERT throws on the
    // not-null constraint.
    account_id: accountId,
    // Original author — kept as audit only. The unique index is
    // still on (user_id, name, language) — see the upsert helper
    // for the cross-teammate dedup follow-up.
    user_id: userId,
    name: payload.name,
    category: payload.category,
    language: payload.language,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
    status: extras.status,
    meta_template_id: extras.metaTemplateId,
    submission_error: extras.submissionError,
    // Which WABA (i.e. which Meta channel) this template was submitted
    // to — null for a dry run, where no real channel is ever resolved.
    waba_id: extras.wabaId,
    // Clear stale rejection_reason whenever we re-submit; the
    // webhook will set it again if Meta still rejects.
    rejection_reason: extras.submissionError ? null : null,
    last_submitted_at: new Date().toISOString(),
  }
}

async function upsertTemplateRow(
  supabase: SupabaseClient,
  row: ReturnType<typeof buildUpsertRow>,
) {
  // TODO(account-sharing): conflict target is still scoped to
  // user_id. Once a follow-up migration drops the legacy unique
  // index on (user_id, name, language) and adds (account_id,
  // name, language), switch `onConflict` here so two teammates
  // can't shadow each other's same-named template.
  return supabase
    .from('message_templates')
    .upsert(row, { onConflict: 'user_id,name,language' })
    .select()
    .single()
}

/**
 * Submit a template to Meta for approval AND persist it locally.
 *
 * Auth → fetch whatsapp_config → validate → (DRY_RUN short-circuit) →
 * POST to Meta → upsert local row by (user_id, name, language) with
 * status, meta_template_id, sample_values, last_submitted_at.
 *
 * When WHATSAPP_TEMPLATES_DRY_RUN=true, we skip the network call and
 * insert a row with a synthetic `dry-run-<uuid>` meta_template_id so
 * CI / local dev can exercise the full UI without a real Meta App.
 *
 * On the Meta side this is a one-way trip — a row can only be
 * submitted; editing or deleting requires hsm_id and lives in PR 4.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Resolve the caller's account_id — whatsapp_config + the
    // message_templates row are account-scoped post-multi-user.
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

    let payload: TemplatePayload
    // channel_id: optional, lets the caller target a specific Meta
    // channel instead of "whichever enabled one comes first" — pulled
    // off the raw body separately so it doesn't leak into
    // TemplatePayload (validateTemplatePayload/buildMetaTemplatePayload
    // don't know about it and shouldn't need to).
    let channelId: string | undefined
    try {
      const body = (await request.json()) as TemplatePayload & { channel_id?: unknown }
      channelId = typeof body.channel_id === 'string' && body.channel_id.trim() ? body.channel_id : undefined
      payload = body
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    if (payload.category === 'Authentication') {
      return NextResponse.json(
        {
          error:
            'AUTHENTICATION templates are not yet supported here — create them in Meta WhatsApp Manager and use "Sync from Meta".',
        },
        { status: 400 },
      )
    }

    try {
      validateTemplatePayload(payload)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Validation failed.' },
        { status: 400 },
      )
    }

    const dryRun =
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
      process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'

    let metaTemplateId: string
    let metaStatus: string
    // Resolved once the channel lookup below succeeds — null for a dry
    // run (no real channel ever gets looked up) or, in principle, if
    // the code path errors out first (all of those `return` before
    // this would be read).
    let resolvedWabaId: string | null = null

    if (dryRun) {
      metaTemplateId = `dry-run-${crypto.randomUUID()}`
      metaStatus = 'PENDING'
    } else {
      let configQuery = supabase
        .from('whatsapp_config')
        .select('*')
        .eq('account_id', accountId)
        .eq('provider', 'meta')

      // channel_id given: use exactly that channel (still scoped to
      // this account — a cross-account id simply matches no row below).
      // Otherwise: the account's oldest enabled Meta channel, same
      // "pick the primary one" convention as /api/v1/whatsapp/send and
      // the whatsapp_config PATCH handler.
      configQuery = channelId
        ? configQuery.eq('id', channelId)
        : configQuery.eq('habilitado', true).order('created_at', { ascending: true }).limit(1)

      const { data: config, error: configError } = await configQuery.maybeSingle()
      if (configError || !config) {
        return NextResponse.json(
          {
            error: channelId
              ? 'Channel not found in your account.'
              : 'No enabled Meta channel found for this account. Connect and enable a Meta WhatsApp channel in Canais first.',
          },
          { status: 400 },
        )
      }
      resolvedWabaId = config.waba_id ?? null
      if (!config.waba_id) {
        return NextResponse.json(
          {
            error:
              'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
          },
          { status: 400 },
        )
      }

      const accessToken = decrypt(config.access_token)

      // Image headers need a Resumable-Upload handle (Meta rejects a
      // plain URL at creation). Derive it from header_media_url before
      // building the payload. Surfaces a 400 with an actionable message
      // (missing META_APP_ID, unreachable URL, wrong type/size).
      try {
        await ensureImageHeaderHandle(payload, accessToken)
      } catch (e) {
        return NextResponse.json(
          { error: e instanceof Error ? e.message : 'Header image upload failed.' },
          { status: 400 },
        )
      }

      const metaPayload = buildMetaTemplatePayload(payload)
      try {
        const meta = await submitMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          payload: metaPayload,
        })
        metaTemplateId = meta.id
        metaStatus = meta.status
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Meta submit failed.'
        // Persist the failure so the user can retry; row stays DRAFT
        // until they fix and re-submit.
        await upsertTemplateRow(
          supabase,
          buildUpsertRow(accountId, user.id, payload, {
            status: 'DRAFT',
            metaTemplateId: null,
            submissionError: message,
            wabaId: resolvedWabaId,
          }),
        )
        const isRateLimit = /\b429\b/.test(message)
        return NextResponse.json(
          {
            error: isRateLimit
              ? 'Meta rate limit hit (100 template creates per hour). Try again later.'
              : message,
          },
          { status: isRateLimit ? 429 : 502 },
        )
      }
    }

    const { data: row, error: upsertErr } = await upsertTemplateRow(
      supabase,
      buildUpsertRow(accountId, user.id, payload, {
        status: normalizeStatus(metaStatus),
        metaTemplateId,
        submissionError: null,
        wabaId: resolvedWabaId,
      }),
    )

    if (upsertErr) {
      // The submit succeeded on Meta's side but we failed to persist
      // locally. That's a data-drift state — surface the meta_template_id
      // so the user can recover via "Sync from Meta".
      return NextResponse.json(
        {
          error: `Submitted to Meta but failed to save locally: ${upsertErr.message}. Run "Sync from Meta" to recover.`,
          meta_template_id: metaTemplateId,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      template: row,
      dry_run: dryRun,
    })
  } catch (error) {
    console.error('Error submitting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to submit template.',
      },
      { status: 500 },
    )
  }
}
