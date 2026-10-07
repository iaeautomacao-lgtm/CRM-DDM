import { NextResponse } from 'next/server'
import { guardRole } from '@/lib/auth/route-guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'

/** Remove da resposta tudo que parece segredo (token, chave, senha). */
function stripSecrets(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([k]) => !/secret|token|key|password/i.test(k)),
  )
}

export async function GET() {
  // Introspecção de debug: desligada por padrão em QUALQUER ambiente (antes
  // dependia só de NODE_ENV e, fora de produção, entregava contatos e
  // conversas a qualquer papel). Só liga com a flag explícita abaixo.
  if (process.env.ENABLE_DEBUG_DB !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    const auth = await guardRole('owner')
    if (!auth.ok) return auth.response
    const { supabase, userId, accountId } = auth.ctx
    const admin = supabaseAdmin()

    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    // 3. Count tables using admin (bypassing RLS), scoped to the caller's account
    const { count: contactsCount } = await admin.from('contacts').select('*', { count: 'exact', head: true }).eq('account_id', accountId)
    const { count: convsCount } = await admin.from('conversations').select('*', { count: 'exact', head: true }).eq('account_id', accountId)
    const { count: configCount } = await admin.from('whatsapp_config').select('*', { count: 'exact', head: true }).eq('account_id', accountId)

    // 4. Fetch the configs and conversations/contacts for this account only
    const { data: configs } = await admin.from('whatsapp_config').select('*').eq('account_id', accountId)
    const { data: conversations } = await admin.from('conversations').select('*').eq('account_id', accountId)
    const { data: contacts } = await admin.from('contacts').select('*').eq('account_id', accountId)

    // messages has no account_id column of its own — it's scoped through
    // conversation_id, so count only messages under this account's conversations.
    const conversationIds = (conversations || []).map((c: { id: string }) => c.id)
    let msgsCount = 0
    if (conversationIds.length > 0) {
      const { count } = await admin
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .in('conversation_id', conversationIds)
      msgsCount = count || 0
    }

    return NextResponse.json({
      auth: {
        userId,
        profileAccountId: profile?.account_id,
        profileRole: profile?.account_role
      },
      counts: {
        contacts: contactsCount,
        conversations: convsCount,
        messages: msgsCount,
        whatsapp_config: configCount
      },
      configs: (configs || []).map(stripSecrets),
      conversations: conversations || [],
      contacts: contacts || []
    })
  } catch (err: any) {
    console.error('[debug-db] erro:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
