import { NextResponse } from 'next/server'
import { getCurrentAccount, requirePermission, toErrorResponse } from '@/lib/auth/account'
import { internalErrorResponse } from '@/lib/api/internal-error'

const NAME_MAX_LENGTH = 50

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('template_folders')
      .select('*')
      .eq('account_id', accountId)
      .order('position', { ascending: true })

    if (error) {
      return internalErrorResponse('templates/folders', error)
    }

    return NextResponse.json({ folders: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requirePermission('templates.manage')

    let body: { name?: string }
    try {
      body = (await request.json()) as { name?: string }
    } catch {
      return NextResponse.json({ error: 'Corpo JSON inválido.' }, { status: 400 })
    }

    const name = body.name?.trim() ?? ''
    if (!name) {
      return NextResponse.json({ error: 'O nome da pasta é obrigatório.' }, { status: 400 })
    }
    if (name.length > NAME_MAX_LENGTH) {
      return NextResponse.json(
        { error: `O nome da pasta excede ${NAME_MAX_LENGTH} caracteres.` },
        { status: 400 },
      )
    }

    // No unique constraint on (account_id, position) — a plain max+1
    // read-then-write has a benign race (two folders created in the
    // same instant could land on the same position), which just means
    // a tied sort order the user can fix by dragging. Not worth a
    // transaction for a manual ordering field.
    const { data: maxRow } = await supabase
      .from('template_folders')
      .select('position')
      .eq('account_id', accountId)
      .order('position', { ascending: false })
      .limit(1)
      .maybeSingle()
    const nextPosition = (maxRow?.position ?? -1) + 1

    const { data: folder, error } = await supabase
      .from('template_folders')
      .insert({ account_id: accountId, name, position: nextPosition })
      .select()
      .single()

    if (error) {
      return internalErrorResponse('templates/folders', error)
    }

    return NextResponse.json({ folder })
  } catch (err) {
    return toErrorResponse(err)
  }
}
