import { beforeEach, describe, expect, it, vi } from 'vitest'
import { logToolCall } from '@/lib/intelligence/audit'
import { currentIntelligenceScope } from '@/lib/intelligence/http'
import { checkIntelligenceToolRate } from '@/lib/intelligence/rate'
import { executeTool, getTool } from '@/lib/intelligence/tools'
import { POST } from './route'

vi.mock('@/lib/intelligence/audit', () => ({ logToolCall: vi.fn() }))
vi.mock('@/lib/intelligence/http', () => ({
  currentIntelligenceScope: vi.fn(),
  intelligenceErrorResponse: (err: unknown) => Response.json({ error: String(err) }, { status: 500 }),
}))
vi.mock('@/lib/intelligence/rate', () => ({ checkIntelligenceToolRate: vi.fn() }))
vi.mock('@/lib/intelligence/tools', () => ({ getTool: vi.fn(), executeTool: vi.fn() }))

const scope = { accountId: 'conta', userId: 'usuario', role: 'owner' as const, teamIds: null }
const tool = {
  name: 'get_overview_metrics',
  description: 'Métricas',
  inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false as const },
  validate: (input: unknown) => input,
  run: async () => ({ total: 1 }),
}

beforeEach(() => {
  vi.mocked(currentIntelligenceScope).mockResolvedValue(scope)
  vi.mocked(getTool).mockReturnValue(tool)
  vi.mocked(checkIntelligenceToolRate).mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: 0 })
  vi.mocked(logToolCall).mockResolvedValue(undefined)
})

async function request() {
  return POST(new Request('https://crm.example.com/api/intelligence/tools/get_overview_metrics', {
    method: 'POST',
    body: JSON.stringify({ origin: 'mcp' }),
  }), { params: Promise.resolve({ name: tool.name }) })
}

describe('POST intelligence/tools — origem da auditoria', () => {
  it('audita sucesso como api, independentemente do corpo enviado', async () => {
    vi.mocked(executeTool).mockResolvedValue({ total: 1 })
    const response = await request()
    expect(response.status).toBe(200)
    expect(logToolCall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      origin: 'api', scope, toolName: tool.name, success: true,
    }))
  })

  it('audita falha como api', async () => {
    vi.mocked(executeTool).mockRejectedValue(new Error('falha na consulta'))
    const response = await request()
    expect(response.status).toBe(500)
    expect(logToolCall).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      origin: 'api', scope, success: false, resultSize: null, error: 'falha na consulta',
    }))
  })
})
