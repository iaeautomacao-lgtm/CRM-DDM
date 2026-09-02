import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

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
      return NextResponse.json({ error: 'Invalid folder id.' }, { status: 400 })
    }

    const { supabase, accountId } = await requireRole('admin')

    let body: { name?: string; position?: number }
    try {
      body = (await request.json()) as { name?: string; position?: number }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    const patch: { name?: string; position?: number } = {}

    if (body.name !== undefined) {
      const name = body.name.trim()
      if (!name) {
        return NextResponse.json({ error: 'Folder name cannot be empty.' }, { status: 400 })
      }
      if (name.length > NAME_MAX_LENGTH) {
        return NextResponse.json(
          { error: `Folder name exceeds ${NAME_MAX_LENGTH} characters.` },
          { status: 400 },
        )
      }
      patch.name = name
    }

    if (body.position !== undefined) {
      if (!Number.isInteger(body.position)) {
        return NextResponse.json({ error: 'position must be an integer.' }, { status: 400 })
      }
      patch.position = body.position
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 })
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
      return NextResponse.json({ error: 'Folder not found.' }, { status: 404 })
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
      return NextResponse.json({ error: 'Invalid folder id.' }, { status: 400 })
    }

    const { supabase, accountId } = await requireRole('admin')

    const { data: existing, error: lookupErr } = await supabase
      .from('template_folders')
      .select('id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle()
    if (lookupErr || !existing) {
      return NextResponse.json({ error: 'Folder not found.' }, { status: 404 })
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
