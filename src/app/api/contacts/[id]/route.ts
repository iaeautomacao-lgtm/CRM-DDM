import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { parseCpf, parseEmail, parseName, serializeContact } from '@/lib/contacts/contact-api'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// PATCH /api/contacts/[id]  { name?, cpf?, email? }   (PRD 23, item 4 — CPF / Nome no painel do contato)
//
// Edita nome, CPF e e-mail do contato com validação (CPF com dígito verificador, só dígitos no banco como na importação; `null` ou "" limpa
// o campo). Permissão contacts.edit — vale também para papéis personalizados (a escrita é feita no servidor, depois de conferir a conta).
// O CPF NUNCA volta em claro: a resposta traz `cpf_masked` e `has_cpf`. A auditoria do UPDATE vem do trigger da migration 222 (sem PII em claro).
// Telefone não é editável aqui (muda a identidade do contato: use /api/contacts/[id]/link ou o fluxo de unir contatos).
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requirePermission('contacts.edit')
    const { id } = await params
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Corpo inválido' }, { status: 400 })

    const patch: Record<string, string | null> = {}
    if ('name' in body) {
      const name = parseName(body.name)
      if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 })
      if (name.value === null) return NextResponse.json({ error: 'O nome não pode ficar vazio' }, { status: 400 })
      patch.name = name.value
    }
    if ('cpf' in body) {
      const cpf = parseCpf(body.cpf)
      if (!cpf.ok) return NextResponse.json({ error: cpf.error }, { status: 400 })
      patch.cpf = cpf.value
    }
    if ('email' in body) {
      const email = parseEmail(body.email)
      if (!email.ok) return NextResponse.json({ error: email.error }, { status: 400 })
      patch.email = email.value
    }
    if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nada para atualizar (name, cpf ou email)' }, { status: 400 })

    const { data, error } = await supabaseAdmin()
      .from('contacts')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', accountId)
      .select('*')
      .limit(1)
    if (error) throw error
    const updated = data?.[0]
    if (!updated) return NextResponse.json({ error: 'Contato não encontrado' }, { status: 404 })
    return NextResponse.json({ contact: serializeContact(updated) })
  } catch (err) {
    return toErrorResponse(err)
  }
}
