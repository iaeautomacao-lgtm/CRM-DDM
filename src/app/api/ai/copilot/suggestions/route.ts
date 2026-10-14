import { NextResponse } from 'next/server'
import { guardPermission } from '@/lib/auth/route-guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { COPILOT_ERROR_STATUS, getCopilotSuggestions } from '@/lib/ai/copilot'
import { checkRateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// POST /api/ai/copilot/suggestions  { conversationId: string, force?: boolean }   (Acordito, o copiloto do atendente — decisão do dono, 14/10)
//   → 200 { suggestions: [{ id, text }], basedOnMessageId, cached }
//   → erro { code: 'ai_not_configured' (409) | 'copilot_disabled' (409) | 'quota_exceeded' (429) | 'forbidden' (403) | 'ai_bad_response' | 'ai_failed' (502) }
// Gera 3 sugestões a partir do histórico recente, do contato e das respostas rápidas visíveis ao usuário. NUNCA envia mensagem.
// Mesma regra do envio no inbox: inbox.reply + conversa lida com a sessão do usuário (RLS, inclusive escopo de equipe).
// Cache por conversa + última mensagem do cliente (`force` gera de novo); chave/modelo e cota diária da conta.
export async function POST(request: Request) {
  const auth = await guardPermission('inbox.reply')
  if (!auth.ok) return auth.response
  const { supabase, accountId, userId } = auth.ctx

  const limit = await checkRateLimit(`ai-copilot:${userId}`, RATE_LIMITS.aiCopilot)
  if (!limit.success) return rateLimitResponse(limit)

  const body = (await request.json().catch(() => null)) as { conversationId?: unknown; force?: unknown } | null
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId.trim() : ''
  if (!UUID.test(conversationId)) return NextResponse.json({ error: 'conversationId inválido' }, { status: 400 })
  if (body?.force !== undefined && typeof body.force !== 'boolean') return NextResponse.json({ error: 'force deve ser booleano' }, { status: 400 })

  try {
    const outcome = await getCopilotSuggestions({
      userDb: supabase,
      adminDb: supabaseAdmin(),
      accountId,
      userId,
      conversationId,
      force: body?.force === true,
    })
    if (!outcome.ok) return NextResponse.json({ error: outcome.code, code: outcome.code }, { status: COPILOT_ERROR_STATUS[outcome.code] })
    return NextResponse.json({ suggestions: outcome.suggestions, basedOnMessageId: outcome.basedOnMessageId, cached: outcome.cached })
  } catch (err) {
    console.error('[ai/copilot] suggestions falhou:', err instanceof Error ? err.message.slice(0, 160) : 'erro')
    return NextResponse.json({ error: 'Falha ao gerar as sugestões' }, { status: 500 })
  }
}
