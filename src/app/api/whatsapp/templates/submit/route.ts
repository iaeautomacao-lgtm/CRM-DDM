import { templatesDryRunEnabled } from '@/lib/whatsapp/templates-dry-run'
import { NextResponse } from 'next/server'
import { fetchChannelConfigs } from '@/lib/whatsapp/channel-config'
import type { SupabaseClient } from '@supabase/supabase-js'
import { guardPermission } from '@/lib/auth/route-guard'
import { decrypt } from '@/lib/whatsapp/encryption'
import { submitMessageTemplate } from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize'
import { pickCatalogRowId } from '@/lib/whatsapp/template-catalog'

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
    // Original author — kept as audit only. A chave única é
    // (account_id, waba_id, name, language) — migration 160.
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
  // Chave do catálogo: (account_id, waba_id, name, language) — migration
  // 160. O mesmo nome/idioma em duas WABAs são duas linhas (antes a chave
  // (user_id, name, language) fazia o último submit/sync sobrescrever o
  // waba_id do outro número). Busca + update/insert em vez de
  // upsert(onConflict) para funcionar antes e depois da migration.
  //
  // Prioridade: linha desta WABA → linha antiga sem waba_id (adotada: o
  // update grava o waba_id nela) → insert. Antes o submit inseria a linha
  // da WABA ao lado da antiga, e as duas passavam a coexistir (a antiga
  // aprovada mascarava a nova rejeitada na validação da campanha).
  // waba_id vem de whatsapp_config (só dígitos) — seguro no filtro .or().
  const lookup = supabase
    .from('message_templates')
    .select('id, waba_id')
    .eq('account_id', row.account_id)
    .eq('name', row.name)
    .eq('language', row.language)
  const { data: candidates, error: lookupErr } = await (row.waba_id
    ? lookup.or(`waba_id.eq.${row.waba_id},waba_id.is.null`)
    : lookup.is('waba_id', null)
  ).limit(20)
  if (lookupErr) return { data: null, error: lookupErr }

  const existingId = pickCatalogRowId(
    (candidates ?? []) as Array<{ id: string; waba_id: string | null }>,
    row.waba_id,
  )
  if (existingId) {
    return supabase
      .from('message_templates')
      .update(row)
      .eq('id', existingId)
      .select()
      .single()
  }
  return supabase.from('message_templates').insert(row).select().single()
}

/**
 * Submit a template to Meta for approval AND persist it locally.
 *
 * Auth → fetch whatsapp_config → validate → (DRY_RUN short-circuit) →
 * POST to Meta → upsert local row by (account_id, waba_id, name, language) with
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
    // Templates/canais mexem no WABA da conta (Meta) ou no número conectado: só admin
    // (mesmo papel das páginas /templates e /canais).
    const auth = await guardPermission('templates.manage')
    if (!auth.ok) return auth.response
    const { supabase, accountId } = auth.ctx

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
      return NextResponse.json({ error: 'Corpo JSON inválido.' }, { status: 400 })
    }

    if (payload.category === 'Authentication') {
      return NextResponse.json(
        {
          error:
            'Templates de AUTENTICAÇÃO ainda não são suportados aqui — crie-os no Gerenciador do WhatsApp da Meta e use "Sincronizar do Meta".',
        },
        { status: 400 },
      )
    }

    try {
      validateTemplatePayload(payload)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Falha na validação.' },
        { status: 400 },
      )
    }

    const dryRun = templatesDryRunEnabled()

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
      // channel_id given: use exactly that channel (still scoped to
      // this account — a cross-account id simply matches no row below).
      // Otherwise: the account's oldest enabled Meta channel, same
      // "pick the primary one" convention as /api/v1/whatsapp/send and
      // the whatsapp_config PATCH handler.
      // Segredos só pelo servidor (migration 200b); visibilidade = RLS do usuário.
      const { data: configRows, error: configError } = await fetchChannelConfigs(
        supabase,
        accountId,
        (q) => {
          const base = q.eq('account_id', accountId).eq('provider', 'meta')
          return channelId
            ? base.eq('id', channelId)
            : base.eq('habilitado', true).order('created_at', { ascending: true }).limit(1)
        }
      )
      const config = (configRows?.[0] ?? null) as any
      if (configError || !config) {
        return NextResponse.json(
          {
            error: channelId
              ? 'Canal não encontrado na sua conta.'
              : 'Nenhum canal Meta habilitado nesta conta. Conecte e habilite primeiro um canal WhatsApp Meta em Canais.',
          },
          { status: 400 },
        )
      }
      resolvedWabaId = config.waba_id ?? null
      if (!config.waba_id) {
        return NextResponse.json(
          {
            error:
              'ID da WABA (conta do WhatsApp Business) ausente. Reconecte sua conta nas Configurações.',
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
          { error: e instanceof Error ? e.message : 'Falha no envio da imagem do cabeçalho.' },
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
        const message = e instanceof Error ? e.message : 'Falha no envio à Meta.'
        // Persist the failure so the user can retry; row stays DRAFT
        // until they fix and re-submit.
        await upsertTemplateRow(
          supabase,
          buildUpsertRow(accountId, auth.ctx.userId, payload, {
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
              ? 'Limite da Meta atingido (100 criações de template por hora). Tente novamente mais tarde.'
              : message,
          },
          { status: isRateLimit ? 429 : 502 },
        )
      }
    }

    const { data: row, error: upsertErr } = await upsertTemplateRow(
      supabase,
      buildUpsertRow(accountId, auth.ctx.userId, payload, {
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
          error: `Enviado à Meta, mas falhou ao salvar localmente: ${upsertErr.message}. Use "Sincronizar do Meta" para recuperar.`,
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
          error instanceof Error ? error.message : 'Falha ao enviar o template.',
      },
      { status: 500 },
    )
  }
}
