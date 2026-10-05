import { NextResponse } from 'next/server'
import { currentIntelligenceScope, intelligenceErrorResponse } from '@/lib/intelligence/http'
import { describeScope } from '@/lib/intelligence/scope'
import { listTools } from '@/lib/intelligence/tools'

// GET /api/intelligence/tools — catálogo das ferramentas do DDM
// Intelligence (Fase 1, validação sem chat). Owner/admin/supervisor.

export async function GET() {
  try {
    const scope = await currentIntelligenceScope()
    return NextResponse.json({ tools: listTools(), scope: describeScope(scope) })
  } catch (err) {
    return intelligenceErrorResponse(err)
  }
}
