import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { AUTO_MANAGED_TAG_NAMES } from '@/lib/contacts/contact-api'
import { supabaseAdmin } from '@/lib/flows/admin-client'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// GET  /api/contacts/[id]/tags            → etiquetas do contato e as disponíveis na conta (para o seletor do painel)
// POST /api/contacts/[id]/tags { tag_id } → liga a etiqueta ao contato (idempotente)            (PRD 23, item 20)
// A remoção é DELETE /api/contacts/[id]/tags/[tagId]. Permissão contacts.edit (GET: contacts.view). Só etiquetas da MESMA conta; as que a
// automação da conversa gerencia sozinha ("IA Conversando", "Atendimento Humano") ficam de fora (409). A auditoria vem do trigger da 222.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requirePermission('contacts.view')
    const { id } = await params
    const db = supabaseAdmin()
    const { data: contact } = await db.from('contacts').select('id').eq('id', id).eq('account_id', accountId).limit(1)
    if (!contact?.[0]) return NextResponse.json({ error: 'Contato não encontrado' }, { status: 404 })

    const [{ data: links, error: linkError }, { data: tags, error: tagError }] = await Promise.all([
      db.from('contact_tags').select('tag_id').eq('contact_id', id).limit(1000),
      db.from('tags').select('id, name, color').eq('account_id', accountId).order('name', { ascending: true }).limit(1000),
    ])
    if (linkError) throw linkError
    if (tagError) throw tagError
    const applied = new Set((links ?? []).map((l: { tag_id: string }) => l.tag_id))
    const available = (tags ?? []).filter((t: { name: string }) => !AUTO_MANAGED_TAG_NAMES.has(t.name))
    return NextResponse.json({
      applied: available.filter((t: { id: string }) => applied.has(t.id)),
      available,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requirePermission('contacts.edit')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as { tag_id?: unknown } | null
    const tagId = typeof body?.tag_id === 'string' ? body.tag_id : ''
    if (!UUID.test(tagId)) return NextResponse.json({ error: 'tag_id inválido' }, { status: 400 })

    const db = supabaseAdmin()
    const [{ data: contact }, { data: tag }] = await Promise.all([
      db.from('contacts').select('id').eq('id', id).eq('account_id', accountId).limit(1),
      db.from('tags').select('id, name, color').eq('id', tagId).eq('account_id', accountId).limit(1),
    ])
    if (!contact?.[0]) return NextResponse.json({ error: 'Contato não encontrado' }, { status: 404 })
    if (!tag?.[0]) return NextResponse.json({ error: 'Etiqueta não encontrada' }, { status: 404 })
    if (AUTO_MANAGED_TAG_NAMES.has(tag[0].name)) {
      return NextResponse.json({ error: 'Esta etiqueta é gerenciada automaticamente pela conversa' }, { status: 409 })
    }

    const { error } = await db.from('contact_tags').upsert({ contact_id: id, tag_id: tagId }, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true })
    if (error) throw error
    return NextResponse.json({ ok: true, tag: tag[0] })
  } catch (err) {
    return toErrorResponse(err)
  }
}
