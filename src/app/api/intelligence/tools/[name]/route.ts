import { NextResponse } from 'next/server'
import { logToolCall } from '@/lib/intelligence/audit'
import { BadRequestError } from '@/lib/intelligence/errors'
import { currentIntelligenceScope, intelligenceErrorResponse } from '@/lib/intelligence/http'
import { describeScope } from '@/lib/intelligence/scope'
import { executeTool, getTool } from '@/lib/intelligence/tools'
import { checkIntelligenceToolRate } from '@/lib/intelligence/rate'
import { rateLimitResponse } from '@/lib/rate-limit'

// POST /api/intelligence/tools/[name] — executa uma ferramenta do DDM
// Intelligence (Fase 1, validação sem chat). Corpo = input da ferramenta.
// O escopo (conta/equipes) vem da sessão, nunca do corpo. Toda chamada
// que passa da autenticação é auditada (intelligence_tool_calls, 141).
// O limite por usuário (rate.ts) é o mesmo balde usado pelo chat.

export async function POST(
  request: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  try {
    const scope = await currentIntelligenceScope()
    const { name } = await params
    const tool = getTool(name)
    if (!tool) return NextResponse.json({ error: `Ferramenta desconhecida: ${name}` }, { status: 404 })

    const limit = checkIntelligenceToolRate(scope.userId)
    if (!limit.success) return rateLimitResponse(limit)

    let body: unknown = {}
    const raw = await request.text()
    if (raw.trim()) {
      try {
        body = JSON.parse(raw)
      } catch {
        return intelligenceErrorResponse(new BadRequestError('Corpo deve ser JSON válido'))
      }
    }

    const startedAt = Date.now()
    try {
      const result = await executeTool(tool, scope, body)
      const json = JSON.stringify(result)
      await logToolCall({
        origin: 'api',
        scope,
        toolName: tool.name,
        args: body,
        durationMs: Date.now() - startedAt,
        success: true,
        resultSize: json.length,
      })
      return NextResponse.json({ result, scope: describeScope(scope) })
    } catch (err) {
      await logToolCall({
        origin: 'api',
        scope,
        toolName: tool.name,
        args: body,
        durationMs: Date.now() - startedAt,
        success: false,
        resultSize: null,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  } catch (err) {
    return intelligenceErrorResponse(err)
  }
}
