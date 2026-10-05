import { supabaseAdmin } from '@/lib/flows/admin-client'
import { requireActiveSession, webchatJson } from '@/lib/webchat/api'

// GET /api/webchat/[token] — dados da sessão para a página do cliente:
// marca (nome da conta), primeiro nome do contato e validade do link.
// Só leitura: abrir a conversa é o POST /open.

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const result = await requireActiveSession(token)
  if ('response' in result) return result.response
  const { session } = result
  const db = supabaseAdmin()

  const [{ data: accounts }, { data: contacts }] = await Promise.all([
    db.from('accounts').select('name').eq('id', session.account_id).limit(1),
    db.from('contacts').select('name').eq('id', session.contact_id).eq('account_id', session.account_id).limit(1),
  ])
  const firstName = (contacts?.[0]?.name ?? '').trim().split(/\s+/)[0] || null

  return webchatJson({
    state: 'active',
    brand: { name: accounts?.[0]?.name ?? 'Atendimento' },
    contact: { first_name: firstName },
    expires_at: session.expires_at,
    opened: !!session.webchat_conversation_id,
  })
}
