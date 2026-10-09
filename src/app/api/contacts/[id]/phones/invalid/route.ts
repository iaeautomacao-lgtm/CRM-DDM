import { NextResponse } from 'next/server'
import { logAuditEvent } from '@/lib/audit/log-event'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// POST /api/contacts/[id]/phones/invalid  { ordem: 1|2|3, status?: 'invalido' | 'ativo' }   (PRD 23, item 8 — "número errado")
//
// O operador sinaliza que o telefone da posição `ordem` está errado (status = 'invalido', padrão) — ou desfaz o engano ('ativo'). A escada
// do disparador já pula telefones inválidos (migration 086). ordem 1 = o telefone principal do contato (contacts.phone, implícito): a linha
// em contact_phones é criada se ainda não existir; 2 e 3 são os telefones alternativos e precisam existir (404 se não). Permissão
// contacts.edit. Auditoria: contact.phone_flagged (sem o número em claro).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requirePermission('contacts.edit')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as { ordem?: unknown; status?: unknown } | null
    const ordem = Number(body?.ordem)
    if (![1, 2, 3].includes(ordem)) return NextResponse.json({ error: 'ordem deve ser 1, 2 ou 3' }, { status: 400 })
    const status = body?.status === undefined ? 'invalido' : body.status
    if (status !== 'invalido' && status !== 'ativo') return NextResponse.json({ error: "status deve ser 'invalido' ou 'ativo'" }, { status: 400 })

    const db = supabaseAdmin()
    const { data: contactRows } = await db
      .from('contacts')
      .select('id, phone, phone_normalized')
      .eq('id', id)
      .eq('account_id', accountId)
      .limit(1)
    const contact = contactRows?.[0]
    if (!contact) return NextResponse.json({ error: 'Contato não encontrado' }, { status: 404 })

    const patch = { status, last_attempt_at: new Date().toISOString() }
    if (ordem > 1) {
      const { data, error } = await db.from('contact_phones').update(patch).eq('contact_id', id).eq('ordem', ordem).select('id')
      if (error) throw error
      if (!data?.length) return NextResponse.json({ error: 'Telefone alternativo não encontrado' }, { status: 404 })
    } else {
      const normalized = contact.phone_normalized as string | null
      if (!normalized) return NextResponse.json({ error: 'O contato não tem telefone principal' }, { status: 400 })
      // O principal pode já ter linha em contact_phones (ordem 1 pelo import/escada); senão cria a linha com a ordem 1.
      const { data: updated, error } = await db
        .from('contact_phones')
        .update(patch)
        .eq('contact_id', id)
        .eq('phone_normalized', normalized)
        .select('id')
      if (error) throw error
      if (!updated?.length) {
        const { error: upsertError } = await db
          .from('contact_phones')
          .upsert({ contact_id: id, phone: contact.phone, phone_normalized: normalized, ordem: 1, ...patch }, { onConflict: 'contact_id,ordem' })
        if (upsertError) throw upsertError
      }
    }

    await logAuditEvent({
      accountId,
      eventType: 'action',
      resourceType: 'contact',
      resourceId: id,
      action: 'contact.phone_flagged',
      summary: status === 'invalido' ? `Telefone ${ordem} do contato marcado como número errado` : `Telefone ${ordem} do contato voltou a ativo`,
      metadata: { ordem, status },
    })
    return NextResponse.json({ ok: true, ordem, status })
  } catch (err) {
    return toErrorResponse(err)
  }
}
