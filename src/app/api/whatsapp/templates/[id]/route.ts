import { templatesDryRunEnabled } from '@/lib/whatsapp/templates-dry-run'
import { NextResponse } from 'next/server'
import { fetchChannelConfigs } from '@/lib/whatsapp/channel-config'
import { guardPermission } from '@/lib/auth/route-guard'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  deleteMessageTemplate,
  editMessageTemplate,
} from '@/lib/whatsapp/meta-api'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components'
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle'
import { internalErrorResponse } from '@/lib/api/internal-error'

/**
 * Per-template lifecycle endpoint.
 *
 * PATCH  — edit an existing Meta-side template (and re-submit). Used
 *          by the "Edit" action on APPROVED rows and the "Resubmit"
 *          action on REJECTED / PAUSED rows. Meta replaces components
 *          wholesale on edit and bumps status back to PENDING.
 *
 * DELETE — remove the template on Meta (when meta_template_id is set,
 *          scoped to a single language variant via hsm_id) AND drop
 *          the local row. Local-only rows skip the Meta call.
 *
 * Initial submission (DRAFT → PENDING) lives at the sibling
 * /submit endpoint — keep this route narrowly about lifecycle of
 * already-submitted templates.
 */

const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED'])

// uuid v4 plus the looser shape Postgres gen_random_uuid emits.
// We don't need exhaustive RFC parsing — just enough to reject
// "../etc/passwd"-style payloads before they hit Supabase.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isDryRun(): boolean {
  return templatesDryRunEnabled()
}

// Local-only organizational fields (folder placement, channel tags) —
// never sent to Meta, so a change here must NOT flip status back to
// PENDING or trigger editMessageTemplate. Bodies containing only
// these keys take the lightweight branch below instead of the full
// Meta-edit flow.
const METADATA_PATCH_KEYS = new Set(['folder_id', 'channel_tags'])
const CHANNEL_TAG_MAX_LENGTH = 40
const CHANNEL_TAGS_MAX_COUNT = 20

interface TemplateMetadataPatch {
  folder_id?: string | null
  channel_tags?: string[]
}

function isMetadataOnlyBody(body: Record<string, unknown>): boolean {
  const keys = Object.keys(body)
  return keys.length > 0 && keys.every((k) => METADATA_PATCH_KEYS.has(k))
}

async function handleMetadataPatch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  accountId: string,
  id: string,
  body: TemplateMetadataPatch,
): Promise<NextResponse> {
  const patch: { folder_id?: string | null; channel_tags?: string[] | null } = {}

  if ('folder_id' in body) {
    if (body.folder_id !== null && !UUID_RE.test(body.folder_id ?? '')) {
      return NextResponse.json({ error: 'folder_id inválido.' }, { status: 400 })
    }
    if (body.folder_id !== null) {
      const { data: folder } = await supabase
        .from('template_folders')
        .select('id')
        .eq('id', body.folder_id)
        .eq('account_id', accountId)
        .maybeSingle()
      if (!folder) {
        return NextResponse.json({ error: 'Pasta não encontrada.' }, { status: 404 })
      }
    }
    patch.folder_id = body.folder_id
  }

  if ('channel_tags' in body) {
    if (!Array.isArray(body.channel_tags) || !body.channel_tags.every((t) => typeof t === 'string')) {
      return NextResponse.json({ error: 'channel_tags deve ser uma lista de textos.' }, { status: 400 })
    }
    const tags = [
      ...new Set(body.channel_tags.map((t) => t.trim()).filter(Boolean)),
    ]
    if (tags.length > CHANNEL_TAGS_MAX_COUNT) {
      return NextResponse.json(
        { error: `No máximo ${CHANNEL_TAGS_MAX_COUNT} tags de canal.` },
        { status: 400 },
      )
    }
    if (tags.some((t) => t.length > CHANNEL_TAG_MAX_LENGTH)) {
      return NextResponse.json(
        { error: `As tags de canal devem ter no máximo ${CHANNEL_TAG_MAX_LENGTH} caracteres.` },
        { status: 400 },
      )
    }
    patch.channel_tags = tags.length > 0 ? tags : null
  }

  const { data: template, error } = await supabase
    .from('message_templates')
    .update(patch)
    .eq('id', id)
    .eq('account_id', accountId)
    .select()
    .maybeSingle()

  if (error) {
    return internalErrorResponse('templates/[id]', error)
  }
  if (!template) {
    return NextResponse.json({ error: 'Template não encontrado.' }, { status: 404 })
  }

  return NextResponse.json({ success: true, template })
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'ID de template inválido.' },
        { status: 400 },
      )
    }
    // Templates/canais mexem no WABA da conta (Meta) ou no número conectado: só admin
    // (mesmo papel das páginas /templates e /canais).
    const auth = await guardPermission('templates.manage')
    if (!auth.ok) return auth.response
    const { supabase, accountId } = auth.ctx

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Corpo JSON inválido.' }, { status: 400 })
    }
    if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      return NextResponse.json({ error: 'Corpo JSON inválido.' }, { status: 400 })
    }

    if (isMetadataOnlyBody(rawBody as Record<string, unknown>)) {
      return handleMetadataPatch(
        supabase,
        accountId,
        id,
        rawBody as TemplateMetadataPatch,
      )
    }

    const payload = rawBody as TemplatePayload

    // RLS handles ownership, but we need the existing row to read
    // meta_template_id and status — fetch explicitly.
    const { data: existing, error: lookupErr } = await supabase
      .from('message_templates')
      .select('id, name, status, meta_template_id, language')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (lookupErr || !existing) {
      return NextResponse.json({ error: 'Template não encontrado.' }, { status: 404 })
    }

    if (!existing.meta_template_id) {
      return NextResponse.json(
        {
          error:
            'Este template nunca foi enviado à Meta — use "Novo template" para enviá-lo.',
        },
        { status: 400 },
      )
    }

    if (!EDITABLE_STATUSES.has(existing.status)) {
      return NextResponse.json(
        {
          error: `Templates com status ${existing.status} não podem ser editados. Permitidos: APPROVED, REJECTED, PAUSED.`,
        },
        { status: 400 },
      )
    }

    if (payload.category === 'Authentication') {
      return NextResponse.json(
        {
          error:
            'Templates de AUTENTICAÇÃO não são editáveis aqui — gerencie-os no Gerenciador do WhatsApp da Meta.',
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

    if (!isDryRun()) {
      // Exatamente 1 canal, como o .single() anterior. // Segredos só pelo servidor (migration 200b); visibilidade = RLS do usuário.
      const { data: configRows, error: configError } = await fetchChannelConfigs(
        supabase,
        accountId,
        (q) => q.eq('account_id', accountId)
      )
      const config = configRows?.length === 1 ? (configRows[0] as any) : null
      if (configError || !config) {
        return NextResponse.json(
          { error: 'WhatsApp não configurado.' },
          { status: 400 },
        )
      }
      const accessToken = decrypt(config.access_token)

      // Image headers need a fresh Resumable-Upload handle on every edit
      // (Meta replaces components wholesale). Derive from header_media_url.
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
        await editMessageTemplate({
          metaTemplateId: existing.meta_template_id,
          accessToken,
          components: metaPayload.components,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Falha na edição na Meta.'
        await supabase
          .from('message_templates')
          .update({
            submission_error: message,
            last_submitted_at: new Date().toISOString(),
          })
          .eq('id', id)
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    // Meta accepted the edit — status flips back to PENDING for review.
    const { data: row, error: updErr } = await supabase
      .from('message_templates')
      .update({
        category: payload.category,
        header_type: payload.header_type ?? null,
        header_content: payload.header_content ?? null,
        header_media_url: payload.header_media_url ?? null,
        header_handle: payload.header_handle ?? null,
        body_text: payload.body_text,
        footer_text: payload.footer_text ?? null,
        buttons: payload.buttons ?? null,
        sample_values: payload.sample_values ?? null,
        status: 'PENDING',
        submission_error: null,
        rejection_reason: null,
        last_submitted_at: new Date().toISOString(),
      })
      .eq('id', id)
      .select()
      .single()

    if (updErr) {
      return NextResponse.json(
        {
          error: `Editado na Meta, mas falhou ao salvar localmente: ${updErr.message}. Use "Sincronizar do Meta" para recuperar.`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({
      success: true,
      template: row,
      dry_run: isDryRun(),
    })
  } catch (error) {
    console.error('Error editing template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Falha ao editar o template.',
      },
      { status: 500 },
    )
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'ID de template inválido.' },
        { status: 400 },
      )
    }
    // Templates/canais mexem no WABA da conta (Meta) ou no número conectado: só admin
    // (mesmo papel das páginas /templates e /canais).
    const auth = await guardPermission('templates.manage')
    if (!auth.ok) return auth.response
    const { supabase, accountId } = auth.ctx

    const { data: existing, error: lookupErr } = await supabase
      .from('message_templates')
      .select('id, name, meta_template_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (lookupErr || !existing) {
      return NextResponse.json({ error: 'Template não encontrado.' }, { status: 404 })
    }

    if (existing.meta_template_id && !isDryRun()) {
      // Exatamente 1 canal, como o .single() anterior. // Segredos só pelo servidor (migration 200b); visibilidade = RLS do usuário.
      const { data: configRows, error: configError } = await fetchChannelConfigs(
        supabase,
        accountId,
        (q) => q.eq('account_id', accountId)
      )
      const config = configRows?.length === 1 ? (configRows[0] as any) : null
      if (configError || !config || !config.waba_id) {
        return NextResponse.json(
          { error: 'WhatsApp não configurado — não é possível excluir na Meta.' },
          { status: 400 },
        )
      }
      const accessToken = decrypt(config.access_token)
      try {
        await deleteMessageTemplate({
          wabaId: config.waba_id,
          accessToken,
          name: existing.name,
          metaTemplateId: existing.meta_template_id,
        })
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Falha na exclusão na Meta.'
        return NextResponse.json({ error: message }, { status: 502 })
      }
    }

    const { error: delErr } = await supabase
      .from('message_templates')
      .delete()
      .eq('id', id)
    if (delErr) {
      return NextResponse.json(
        {
          error: `Excluído na Meta, mas falhou ao excluir localmente: ${delErr.message}.`,
        },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, dry_run: isDryRun() })
  } catch (error) {
    console.error('Error deleting template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Falha ao excluir o template.',
      },
      { status: 500 },
    )
  }
}
