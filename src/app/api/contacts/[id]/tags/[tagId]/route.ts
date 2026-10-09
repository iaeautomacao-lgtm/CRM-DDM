import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { AUTO_MANAGED_TAG_NAMES } from '@/lib/contacts/contact-api'
import { supabaseAdmin } from '@/lib/flows/admin-client'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// DELETE /api/contacts/[id]/tags/[tagId] — remove a etiqueta do contato (PRD 23, item 20). Idempotente (já sem a etiqueta = ok).
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; tagId: string }> }) {
  try {
    const { accountId } = await requirePermission('contacts.edit')
    const { id, tagId } = await params
    if (!UUID.test(tagId)) return NextResponse.json({ error: 'tag_id inválido' }, { status: 400 })

    const db = supabaseAdmin()
    const [{ data: contact }, { data: tag }] = await Promise.all([
      db.from('contacts').select('id').eq('id', id).eq('account_id', accountId).limit(1),
      db.from('tags').select('id, name').eq('id', tagId).eq('account_id', accountId).limit(1),
    ])
    if (!contact?.[0]) return NextResponse.json({ error: 'Contato não encontrado' }, { status: 404 })
    if (!tag?.[0]) return NextResponse.json({ error: 'Etiqueta não encontrada' }, { status: 404 })
    if (AUTO_MANAGED_TAG_NAMES.has(tag[0].name)) {
      return NextResponse.json({ error: 'Esta etiqueta é gerenciada automaticamente pela conversa' }, { status: 409 })
    }

    const { error } = await db.from('contact_tags').delete().eq('contact_id', id).eq('tag_id', tagId)
    if (error) throw error
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
