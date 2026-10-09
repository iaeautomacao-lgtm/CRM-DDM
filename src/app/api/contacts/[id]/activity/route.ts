import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { decodeCursor, loadActivity, parseActivityTypes, parseLimit } from '@/lib/contacts/contact-timeline'
import { supabaseAdmin } from '@/lib/flows/admin-client'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET /api/contacts/[id]/activity?limit&cursor&types=message,event,note,deal,assignment   (TASK36, aba "Atividade" do contato)
// Linha do tempo paginada (cursor) só com o que o sistema JÁ registra. Permissão contacts.view, escopo da conta.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requirePermission('contacts.view')
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'Contato não encontrado' }, { status: 404 })
    const url = new URL(request.url)
    const cursor = decodeCursor(url.searchParams.get('cursor'))
    const types = parseActivityTypes(url.searchParams.get('types'))
    if (cursor === 'invalid') return NextResponse.json({ error: 'cursor inválido' }, { status: 400 })
    if (types === 'invalid') return NextResponse.json({ error: 'types inválido' }, { status: 400 })

    const db = supabaseAdmin()
    const { data: contact } = await db.from('contacts').select('id').eq('id', id).eq('account_id', accountId).limit(1)
    if (!contact?.[0]) return NextResponse.json({ error: 'Contato não encontrado' }, { status: 404 })

    return NextResponse.json(await loadActivity(db, accountId, id, { limit: parseLimit(url.searchParams.get('limit')), cursor, types }))
  } catch (err) {
    return toErrorResponse(err)
  }
}
