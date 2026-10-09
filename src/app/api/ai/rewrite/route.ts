import { NextResponse } from 'next/server'
import { guardPermission } from '@/lib/auth/route-guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { REWRITE_MAX_DRAFT_CHARS, REWRITE_TONES, rewriteDraft, type RewriteTone } from '@/lib/ai/rewrite'
import { checkRateLimit, RATE_LIMITS, rateLimitResponse } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

// POST /api/ai/rewrite  { text: string, tones?: ('formal'|'cordial'|'objetivo')[] }   (PRD 23, item 18 — IA no composer)
//
// Recebe o RASCUNHO do operador e devolve o texto corrigido + uma variação por tom pedido. NADA é enviado: o operador escolhe, edita e envia.
// Usa a chave de IA da CONTA (ai_config); conta sem chave ⇒ 409 `ai_not_configured` (nunca cai na chave do .env). Só o rascunho vai ao provedor
// e nada do texto é logado. Limite por usuário: RATE_LIMITS.aiRewrite. Permissão: inbox.ai_assist (agente ou acima).
export async function POST(request: Request) {
  const auth = await guardPermission('inbox.ai_assist')
  if (!auth.ok) return auth.response
  const { accountId, userId } = auth.ctx

  const limit = await checkRateLimit(`ai-rewrite:${userId}`, RATE_LIMITS.aiRewrite)
  if (!limit.success) return rateLimitResponse(limit)

  const body = (await request.json().catch(() => null)) as { text?: unknown; tones?: unknown } | null
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text) return NextResponse.json({ error: 'text é obrigatório' }, { status: 400 })
  if (text.length > REWRITE_MAX_DRAFT_CHARS) {
    return NextResponse.json({ error: `Texto muito longo (máx. ${REWRITE_MAX_DRAFT_CHARS} caracteres)` }, { status: 413 })
  }

  let tones: RewriteTone[] = [...REWRITE_TONES]
  if (body?.tones !== undefined) {
    if (!Array.isArray(body.tones) || body.tones.length === 0 || !body.tones.every((t) => (REWRITE_TONES as readonly unknown[]).includes(t))) {
      return NextResponse.json({ error: `tones deve ser uma lista com: ${REWRITE_TONES.join(', ')}` }, { status: 400 })
    }
    tones = [...new Set(body.tones as RewriteTone[])]
  }

  const outcome = await rewriteDraft(supabaseAdmin(), accountId, text, tones)
  if (!outcome.ok) {
    const status = outcome.code === 'ai_not_configured' ? 409 : 502
    return NextResponse.json({ error: outcome.error, code: outcome.code }, { status })
  }
  return NextResponse.json({ ok: true, ...outcome.result })
}
