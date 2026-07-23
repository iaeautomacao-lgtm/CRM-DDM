import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'

export async function GET() {
  // Debug-only introspection route — never expose it in production.
  if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  try {
    const supabase = await createClient()
    const admin = supabaseAdmin()

    // 1. Get authenticated user
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated in browser session' }, { status: 401 })
    }

    // 2. Get user profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle()

    const accountId = profile?.account_id
    if (!accountId) {
      return NextResponse.json({ error: 'Profile has no account_id' }, { status: 400 })
    }

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
        userId: user.id,
        email: user.email,
        profileAccountId: profile?.account_id,
        profileRole: profile?.account_role
      },
      counts: {
        contacts: contactsCount,
        conversations: convsCount,
        messages: msgsCount,
        whatsapp_config: configCount
      },
      configs: configs || [],
      conversations: conversations || [],
      contacts: contacts || []
    })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
