import { NextResponse } from 'next/server'
import { requirePermission, toErrorResponse } from '@/lib/auth/account'
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
    // Quem responde no inbox (inbox.reply) encerra o fluxo da conversa; o visualizador não (PRD 20, G3). Contexto completo
    // (revisão de segurança 13/10, item 6): papel personalizado, ajuste do cargo, membro desativado e 2FA.
    const ctx = await requirePermission('inbox.reply')
    const supabase = ctx.supabase
    const accountId = ctx.accountId

    const body = await request.json().catch(() => null)
    const conversationId = body?.conversation_id as string | undefined
    const requestedReason = body?.reason as string | undefined
    if (!conversationId) {
      return NextResponse.json({ error: 'conversation_id é obrigatório' }, { status: 400 })
    }

    // A conversa precisa ser VISÍVEL para quem pede: leitura pelo cliente de
    // sessão (RLS: o operador só enxerga as dele e a fila da equipe; supervisor,
    // as das equipes dele). Só depois entra o service role.
    const { data: visible } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!visible) {
      return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })
    }

    // Defense in depth — scoped by account_id, same rationale as every
    // other admin-client entry point (flows/engine.ts, whatsapp/send).
    const { data: conversation } = await supabaseAdmin()
      .from('conversations')
      .select('id, status')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()
    if (!conversation) {
      return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })
    }

    // Motivo real: antes, sem reason, gravava "conversation_closed" mesmo
    // com a conversa aberta — execução encerrada "porque a conversa
    // fechou" numa conversa aberta (estado que a análise encontrou).
    const reason =
      requestedReason?.trim() ||
      ((conversation as { status?: string }).status === 'closed'
        ? 'conversation_closed'
        : 'ended_manually')

    await endActiveRunForConversation(conversationId, reason)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[flows/end-run] failed:', err)
    return toErrorResponse(err)
  }
}
