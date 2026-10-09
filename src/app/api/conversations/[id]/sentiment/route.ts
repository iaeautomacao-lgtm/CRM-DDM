import { NextResponse } from 'next/server'
import { guardPermission } from '@/lib/auth/route-guard'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { analyzeConversationSentimentAndTags } from '@/lib/ai/sentiment'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: conversationId } = await params
    const auth = await guardPermission('inbox.ai_assist')
    if (!auth.ok) return auth.response
    const { supabase, accountId, userId } = auth.ctx
    // A análise usa a chave de IA da conta: conter loops por usuário.
    const limit = await checkRateLimit(`sentiment:${userId}`, { limit: 10, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)

    // 3. Fetch conversation to get contact_id and verify ownership
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('contact_id')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()

    if (convError || !conversation) {
      return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })
    }

    // 4. Trigger sentiment analysis
    await analyzeConversationSentimentAndTags(accountId, conversation.contact_id, conversationId)

    // 5. Fetch the updated conversation sentiment
    const { data: updatedConv } = await supabase
      .from('conversations')
      .select('sentiment')
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .maybeSingle()

    return NextResponse.json({ success: true, sentiment: updatedConv?.sentiment ?? 'unknown' })
  } catch (err) {
    console.error('[API Sentiment] Error:', err)
    return NextResponse.json({ error: 'Falha ao analisar o sentimento da conversa.' }, { status: 500 })
  }
}
