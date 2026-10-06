import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { dailyMessageLimit, countAccountQuestionsToday, listChats } from '@/lib/intelligence/chat/store'
import { currentIntelligenceScope, intelligenceErrorResponse } from '@/lib/intelligence/http'

// GET /api/intelligence/chats — chats do DDM Intelligence do PRÓPRIO
// usuário (mais recentes primeiro) + uso do teto diário da conta.

export async function GET() {
  try {
    const scope = await currentIntelligenceScope()
    const db = supabaseAdmin()
    const [chats, used] = await Promise.all([
      listChats(db, scope),
      countAccountQuestionsToday(db, scope.accountId),
    ])
    return NextResponse.json({ chats, usage: { used, limit: dailyMessageLimit() } })
  } catch (err) {
    return intelligenceErrorResponse(err)
  }
}
