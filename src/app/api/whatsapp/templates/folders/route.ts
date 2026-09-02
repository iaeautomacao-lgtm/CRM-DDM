import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'

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
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ folders: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('admin')

    let body: { name?: string }
    try {
      body = (await request.json()) as { name?: string }
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    const name = body.name?.trim() ?? ''
    if (!name) {
      return NextResponse.json({ error: 'Folder name is required.' }, { status: 400 })
    }
    if (name.length > NAME_MAX_LENGTH) {
      return NextResponse.json(
        { error: `Folder name exceeds ${NAME_MAX_LENGTH} characters.` },
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
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ folder })
  } catch (err) {
    return toErrorResponse(err)
  }
}
