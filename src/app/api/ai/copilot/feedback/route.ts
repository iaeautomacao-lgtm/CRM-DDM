import { NextResponse } from 'next/server'
import { guardPermission } from '@/lib/auth/route-guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { COPILOT_FEEDBACK_ACTIONS, recordCopilotFeedback } from '@/lib/ai/copilot-feedback'
import { checkRateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

// POST /api/ai/copilot/feedback  { suggestionId: string, action: 'used' | 'edited' | 'ignored' }  → 204
// Grava um evento (conta, conversa, usuário, sugestão, ação) para a métrica do Acordito. A sugestão precisa ser da conta do usuário
// (as sugestões ficam guardadas por poucos dias); desconhecida ⇒ 404. Permissão: inbox.reply (quem recebe as sugestões).
export async function POST(request: Request) {
  const auth = await guardPermission('inbox.reply')
  if (!auth.ok) return auth.response
  const { accountId, userId } = auth.ctx

  const limit = await checkRateLimit(`ai-copilot-feedback:${userId}`, RATE_LIMITS.aiCopilot)
  if (!limit.success) return rateLimitResponse(limit)

  const body = (await request.json().catch(() => null)) as { suggestionId?: unknown; action?: unknown } | null
  const suggestionId = typeof body?.suggestionId === 'string' ? body.suggestionId.trim() : ''
  const action = body?.action
  if (!suggestionId || suggestionId.length > 64) return NextResponse.json({ error: 'suggestionId inválido' }, { status: 400 })
  if (typeof action !== 'string' || !(COPILOT_FEEDBACK_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json({ error: `action deve ser: ${COPILOT_FEEDBACK_ACTIONS.join(', ')}` }, { status: 400 })
  }

  try {
    const result = await recordCopilotFeedback(supabaseAdmin(), { accountId, userId, suggestionId, action: action as (typeof COPILOT_FEEDBACK_ACTIONS)[number] })
    if (!result.ok) return NextResponse.json({ error: 'Sugestão não encontrada', code: 'not_found' }, { status: 404 })
    return new Response(null, { status: 204 })
  } catch (err) {
    console.error('[ai/copilot] feedback falhou:', err instanceof Error ? err.message.slice(0, 160) : 'erro')
    return NextResponse.json({ error: 'Falha ao registrar o feedback' }, { status: 500 })
  }
}
