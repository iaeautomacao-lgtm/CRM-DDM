// Regras de requisição do middleware (páginas públicas e checagem de origem em /api). Puro e sem dependência de runtime: roda no Edge e nos testes.
import type { NextRequest } from 'next/server'

// Páginas públicas (sem sessão): tudo o mais é protegido por padrão — uma tela nova nasce protegida em vez de depender de entrar numa lista
// (revisão 13/10, item 29). /api/* tem a sua própria regra mais abaixo (cada rota valida a sessão de verdade).
const PUBLIC_PAGE_PREFIXES = [
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/auth', // callback do Supabase (troca de código por sessão)
  '/join', // aceitar convite
  '/docs', // documentação pública da API
  '/unauthorized', // fora da lista protegida de propósito: evita loop com o portão de papel
  '/w', // webchat público (link do widget)
  '/brand',
  '/opus',
  '/worklets',
] as const

export function isPublicPage(pathname: string): boolean {
  if (pathname === '/') return true // só redireciona para /dashboard (que é protegido)
  return PUBLIC_PAGE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// Chamadas que NÃO vêm do navegador do usuário logado, ou que um site de terceiros chama de propósito: webhooks (Meta/WAHA), crons, o webchat
// público (embutido em outros sites), a API pública com chave e o MCP. Ficam fora da checagem de origem.
const ORIGIN_CHECK_EXEMPT = [
  /\/webhook(s)?(\/|$)/i,
  /\/cron(\/|$)/i,
  /^\/api\/webchat\//,
  /^\/api\/v1\//,
  /^\/api\/mcp(\/|$)/,
  /^\/api\/stress\/run$/,
]

/**
 * Defesa extra de CSRF além do SameSite=Lax (revisão 13/10, item 22): em /api/* com método que escreve e SEM credencial de cabeçalho
 * (Authorization/Bearer), a requisição de um navegador precisa vir do mesmo site. Sec-Fetch-Site manda quando existe (cross-site e same-site
 * são bloqueados; same-origin e none passam); sem ele, vale o Origin (host diferente do nosso = bloqueia); sem nenhum dos dois não é
 * navegador (curl, cron, servidor) e passa — CSRF só existe com navegador, que sempre manda um dos dois.
 */
export function isCrossSiteMutation(request: NextRequest): boolean {
  const { pathname } = request.nextUrl
  if (!pathname.startsWith('/api/') || !MUTATING_METHODS.has(request.method)) return false
  if (request.headers.get('authorization')) return false
  if (ORIGIN_CHECK_EXEMPT.some((re) => re.test(pathname))) return false

  const fetchSite = request.headers.get('sec-fetch-site')
  if (fetchSite) return fetchSite !== 'same-origin' && fetchSite !== 'none'

  const origin = request.headers.get('origin')
  if (!origin) return false
  let originHost: string
  try {
    originHost = new URL(origin).host
  } catch {
    return true // Origin presente mas inválido ("null", lixo): trata como estranho
  }
  const ownHosts = [request.headers.get('x-forwarded-host'), request.headers.get('host'), request.nextUrl.host]
    .filter((h): h is string => !!h)
    .flatMap((h) => h.split(',').map((x) => x.trim().toLowerCase()))
  return !ownHosts.includes(originHost.toLowerCase())
}
