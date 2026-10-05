import { NextResponse } from 'next/server'
import { logAuditEvent } from '@/lib/audit/log-event'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'

// POST /api/contacts/[id]/link  { phone?, email? }
//
// Completa o contato que chegou sem telefone (Instagram/Messenger/Webchat).
// Se o telefone (ou e-mail) já pertence a outro contato da conta, é a
// mesma pessoa vinda por outro canal: une os dois com merge_contact_into,
// mantendo o contato existente (o do WhatsApp, com histórico e campanhas)
// e trazendo para ele as conversas, identidades, tags e notas deste.
//
// Só o service role executa merge_contact_into (migration 128); a
// permissão é checada aqui: agente+ da mesma conta.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { supabase, accountId } = await requireRole('agent')
    const { id: contactId } = await params
    const body = (await request.json().catch(() => ({}))) as { phone?: unknown; email?: unknown }

    const phone = typeof body.phone === 'string' ? normalizePhone(body.phone) : ''
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!phone && !email) {
      return NextResponse.json({ error: 'Informe telefone ou e-mail' }, { status: 400 })
    }
    if (phone && !/^[1-9]\d{7,14}$/.test(phone)) {
      return NextResponse.json({ error: 'Telefone inválido (use DDI + DDD + número)' }, { status: 400 })
    }
    if (email && (!EMAIL_RE.test(email) || email.length > 254)) {
      return NextResponse.json({ error: 'E-mail inválido' }, { status: 400 })
    }

    // RLS do usuário: garante que ele enxerga o contato.
    const { data: own } = await supabase
      .from('contacts')
      .select('id, phone, email')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .limit(1)
    const current = own?.[0]
    if (!current) return NextResponse.json({ error: 'Contato não encontrado' }, { status: 404 })
    // Só completa quem chegou sem telefone: unir a partir de um contato com
    // telefone poderia apagar o número do WhatsApp.
    if (current.phone) {
      return NextResponse.json({ error: 'Contato já tem telefone' }, { status: 400 })
    }

    const db = supabaseAdmin()

    // Outro contato com o mesmo telefone (phone_normalized, migration 022)
    // ou, sem telefone, com o mesmo e-mail.
    let match: { id: string } | undefined
    if (phone) {
      const { data } = await db
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        .eq('phone_normalized', phone)
        .neq('id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      match = data?.[0]
    }
    if (!match && email) {
      const { data } = await db
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        // ILIKE sem curingas: "_" e "%" são comuns em e-mails reais.
        .ilike('email', email.replace(/[\\%_]/g, (ch) => `\\${ch}`))
        .neq('id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      match = data?.[0]
    }

    if (match) {
      const { error } = await db.rpc('merge_contact_into', { p_keep: match.id, p_drop: contactId })
      if (error) throw error
      await logAuditEvent({
        accountId,
        eventType: 'action',
        resourceType: 'contact',
        resourceId: match.id,
        action: 'contact.merged',
        summary: `Contato ${contactId} unido a este contato (${phone ? 'mesmo telefone' : 'mesmo e-mail'})`,
        metadata: { merged_contact_id: contactId, matched_by: phone ? 'phone' : 'email' },
      })
      // Preenche no contato mantido o que veio agora e ele não tinha.
      const { data: kept } = await db.from('contacts').select('*').eq('id', match.id).limit(1)
      const keptRow = kept?.[0]
      if (keptRow && email && !keptRow.email) {
        await db.from('contacts').update({ email }).eq('id', match.id)
        keptRow.email = email
      }
      return NextResponse.json({ contact: keptRow, merged: true })
    }

    const patch: Record<string, string> = {}
    // Mesmo formato do webhook do WhatsApp: só dígitos.
    if (phone) patch.phone = phone
    if (email) patch.email = email
    const { data: updated, error } = await supabase
      .from('contacts')
      .update(patch)
      .eq('id', contactId)
      .select('*')
    if (error) throw error
    return NextResponse.json({ contact: updated?.[0] ?? null, merged: false })
  } catch (err) {
    return toErrorResponse(err)
  }
}
