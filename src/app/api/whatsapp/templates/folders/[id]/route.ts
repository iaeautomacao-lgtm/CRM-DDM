import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'

const NAME_MAX_LENGTH = 50

// uuid v4 plus the looser shape Postgres gen_random_uuid emits —
// same pattern as templates/[id]/route.ts.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'ID de pasta inválido.' }, { status: 400 })
    }

    const { supabase, accountId } = await requirePermission('templates.manage')

    let body: { name?: string; position?: number }
    try {
      body = (await request.json()) as { name?: string; position?: number }
    } catch {
      return NextResponse.json({ error: 'Corpo JSON inválido.' }, { status: 400 })
    }

    const patch: { name?: string; position?: number } = {}

    if (body.name !== undefined) {
      const name = body.name.trim()
      if (!name) {
        return NextResponse.json({ error: 'O nome da pasta não pode ficar vazio.' }, { status: 400 })
      }
      if (name.length > NAME_MAX_LENGTH) {
        return NextResponse.json(
          { error: `O nome da pasta excede ${NAME_MAX_LENGTH} caracteres.` },
          { status: 400 },
        )
      }
      patch.name = name
    }

    if (body.position !== undefined) {
      if (!Number.isInteger(body.position)) {
        return NextResponse.json({ error: 'position deve ser um inteiro.' }, { status: 400 })
      }
      patch.position = body.position
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nada para atualizar.' }, { status: 400 })
    }

    // RLS scopes writes to admin+ members of the folder's own
    // account, but we still filter by account_id explicitly so a
    // cross-account id returns 404 instead of a silent no-op.
    const { data: folder, error } = await supabase
      .from('template_folders')
      .update(patch)
      .eq('id', id)
      .eq('account_id', accountId)
      .select()
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!folder) {
      return NextResponse.json({ error: 'Pasta não encontrada.' }, { status: 404 })
    }

    return NextResponse.json({ folder })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'ID de pasta inválido.' }, { status: 400 })
    }

    const { supabase, accountId } = await requirePermission('templates.manage')

    const { data: existing, error: lookupErr } = await supabase
      .from('template_folders')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (lookupErr || !existing) {
      return NextResponse.json({ error: 'Pasta não encontrada.' }, { status: 404 })
    }

    // Templates in the folder are kept — just unfiled. FK is
    // ON DELETE SET NULL too, so this update is belt-and-suspenders
    // against RLS on message_templates blocking the FK's own cascade.
    const { error: unfileErr } = await supabase
      .from('message_templates')
      .update({ folder_id: null })
      .eq('folder_id', id)
      .eq('account_id', accountId)
    if (unfileErr) {
      return NextResponse.json({ error: unfileErr.message }, { status: 500 })
    }

    const { error: delErr } = await supabase
      .from('template_folders')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 500 })
    }

    return NextResponse.json({ deleted: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
