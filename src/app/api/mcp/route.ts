import { handleMcpRequest } from '@/lib/intelligence/mcp/server'

// POST /api/mcp — servidor MCP (Streamable HTTP, sem estado) do DDM
// Intelligence (PRD-04 Fase 3). Autenticação: `Authorization: Bearer
// wacrm_live_…` de uma chave PESSOAL com o escopo intelligence:read; o
// escopo de dados é o do dono da chave, recalculado a cada requisição.
// Somente leitura. GET/DELETE não são exportados (sem sessão nem stream
// SSE em modo stateless) — o Next responde 405.
// Como conectar: docs/public-api.md, seção "MCP (DDM Intelligence)".

export async function POST(request: Request) {
  return handleMcpRequest(request)
}
