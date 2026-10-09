import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { parseCpf, parseEmail, parseName, parsePhone, serializeContact } from '@/lib/contacts/contact-api'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// POST /api/contacts  { name?, phone, cpf?, email? }   (PRD 23, item 5 — "Nova conversa" com contato novo)
//
// Cria o contato pelo Inbox com a MESMA regra de "mesmo número" do webhook e da importação (findExistingContact: sufixo de 8 dígitos +
// phonesMatch + telefones alternativos). Telefone que já existe NÃO duplica: devolve o contato existente com `created: false` (200) — o
// front abre a conversa dele. Não altera o contato existente (nome/CPF dele ficam como estão). Permissão: contacts.edit.
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requirePermission('contacts.edit')
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Corpo inválido' }, { status: 400 })

    const phone = parsePhone(body.phone)
    if (!phone.ok) return NextResponse.json({ error: phone.error }, { status: 400 })
    const name = parseName(body.name)
    if (!name.ok) return NextResponse.json({ error: name.error }, { status: 400 })
    const cpf = parseCpf(body.cpf)
    if (!cpf.ok) return NextResponse.json({ error: cpf.error }, { status: 400 })
    const email = parseEmail(body.email)
    if (!email.ok) return NextResponse.json({ error: email.error }, { status: 400 })

    const db = supabaseAdmin()
    const existing = await findExistingContact(db, accountId, phone.value)
    if (existing) return NextResponse.json({ contact: serializeContact(existing), created: false })

    const { data, error } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: userId,
        phone: phone.value,
        name: name.value ?? phone.value,
        ...(cpf.value ? { cpf: cpf.value } : {}),
        ...(email.value ? { email: email.value } : {}),
      })
      .select('*')
      .limit(1)

    if (error) {
      // Corrida: outro caminho criou o mesmo número entre a busca e o INSERT (índice único, migration 022).
      if (isUniqueViolation(error)) {
        const raced = await findExistingContact(db, accountId, phone.value)
        if (raced) return NextResponse.json({ contact: serializeContact(raced), created: false })
      }
      throw error
    }
    const created = data?.[0]
    if (!created) throw new Error('Contato não foi criado')
    return NextResponse.json({ contact: serializeContact(created), created: true }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
