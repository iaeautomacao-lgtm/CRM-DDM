import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { decodeCursor, loadContactCampaigns, parseLimit } from '@/lib/contacts/contact-timeline'
import { supabaseAdmin } from '@/lib/flows/admin-client'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET /api/contacts/[id]/campaigns?limit&cursor   (TASK36, aba "Campanhas" do contato)
// Envios do disparador para o contato (um item por envio na fila), do mais recente ao mais antigo, com a campanha. Permissão
// contacts.view, escopo da conta. A leitura usa o índice idx_dmq_contact_scheduled (migration 296b); sem ele só fica mais lenta.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requirePermission('contacts.view')
    const { id } = await params
    if (!UUID.test(id)) return NextResponse.json({ error: 'Contato não encontrado' }, { status: 404 })
    const url = new URL(request.url)
    const cursor = decodeCursor(url.searchParams.get('cursor'))
    if (cursor === 'invalid') return NextResponse.json({ error: 'cursor inválido' }, { status: 400 })

    const db = supabaseAdmin()
    const { data: contact } = await db.from('contacts').select('id').eq('id', id).eq('account_id', accountId).limit(1)
    if (!contact?.[0]) return NextResponse.json({ error: 'Contato não encontrado' }, { status: 404 })

    return NextResponse.json(await loadContactCampaigns(db, accountId, id, { limit: parseLimit(url.searchParams.get('limit')), cursor }))
  } catch (err) {
    return toErrorResponse(err)
  }
}
