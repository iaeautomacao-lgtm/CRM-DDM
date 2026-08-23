import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { endActiveRunForConversation } from '@/lib/flows/engine'

/**
 * Ends the active flow run for a conversation, if one exists. Called as
 * a fire-and-forget side effect by the Inbox and Monitoramento "close
 * conversation" actions (message-thread.tsx, conversations/actions.ts),
 * which update `conversations` directly via the browser Supabase client
 * and have no other way to reach the flow engine's admin-only queries.
 * A no-op when there's no active run.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const conversationId = body?.conversation_id as string | undefined
    const reason = (body?.reason as string | undefined) || 'conversation_closed'
    if (!conversationId) {
      return NextResponse.json({ error: 'conversation_id is required' }, { status: 400 })
    }

    // Defense in depth — scoped by account_id, same rationale as every
    // other admin-client entry point (flows/engine.ts, whatsapp/send).
    const { data: conversation } = await supabaseAdmin()
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    await endActiveRunForConversation(conversationId, reason)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[flows/end-run] failed:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
