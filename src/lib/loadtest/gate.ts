// Gate de segurança da BANCADA DE CARGA (docs/disparador-bancada-carga.md).
//
// Duas variáveis permitem apontar chamadas externas para simuladores locais/de staging:
//   META_API_BASE_URL  → Graph API da Meta (meta-api.ts)      — padrão https://graph.facebook.com
//   OPENAI_BASE_URL    → API da OpenAI (llm-shared/responder)  — padrão https://api.openai.com
// Só valem com DISPATCH_LOAD_TEST=1. Recusam o endereço real (graph.facebook.com / api.openai.com e subdomínios),
// credenciais na URL e — com o gate ligado — um Supabase de PRODUÇÃO no ambiente (LOADTEST_FORBIDDEN_SUPABASE_REFS).
// Se o gate falhar o app ABORTA no boot (instrumentation.ts) e no carregamento do módulo (throw): melhor não subir
// do que enviar mensagens reais por engano ou rodar carga contra a produção. Nunca use com canal/token reais.
// Função pura (recebe o env): testável.

/** Refs do Supabase que a bancada NUNCA pode tocar (mantido igual a scripts/loadtest/lib/forbidden.mjs — há teste). */
export const LOADTEST_FORBIDDEN_SUPABASE_REFS: readonly string[] = ['cyftbffhgjmsfogxawrl']

export const META_REAL_BASE = 'https://graph.facebook.com'
export const OPENAI_REAL_BASE = 'https://api.openai.com'

export class LoadTestGateError extends Error {
  constructor(message: string) {
    super(`[loadtest] ${message}`)
    this.name = 'LoadTestGateError'
  }
}

type Env = Record<string, string | undefined>

const hostMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

export function supabaseRefsInEnv(env: Env): string[] {
  const found: string[] = []
  for (const key of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL']) {
    const value = (env[key] ?? '').toLowerCase()
    for (const ref of LOADTEST_FORBIDDEN_SUPABASE_REFS) if (value.includes(ref)) found.push(`${key} (${ref})`)
  }
  return found
}

function resolveOverride(name: string, env: Env, realBase: string, forbiddenDomains: string[]): string {
  const raw = (env[name] ?? '').trim()
  if (!raw) return realBase
  if (env.DISPATCH_LOAD_TEST !== '1') {
    // Sem a bancada ligada a variável é IGNORADA (usa o serviço real) em vez de derrubar o app:
    // o SDK da OpenAI, por exemplo, lê OPENAI_BASE_URL sozinho, e uma variável esquecida no .env
    // não pode tirar a produção do ar. O mock só é usado com DISPATCH_LOAD_TEST=1.
    console.warn(`[loadtest] ${name} ignorada: só vale com DISPATCH_LOAD_TEST=1. Usando ${realBase}.`)
    return realBase
  }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new LoadTestGateError(`${name} não é uma URL válida.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new LoadTestGateError(`${name} deve ser http(s).`)
  if (url.username || url.password) throw new LoadTestGateError(`${name} não pode conter usuário/senha.`)
  const host = url.hostname.toLowerCase()
  if (forbiddenDomains.some((d) => hostMatches(host, d))) {
    throw new LoadTestGateError(`${name} aponta para o serviço REAL (${host}) — recusado. Use o simulador (scripts/loadtest/mock-meta.mjs).`)
  }
  const prod = supabaseRefsInEnv(env)
  if (prod.length) {
    throw new LoadTestGateError(`DISPATCH_LOAD_TEST=1 com Supabase de PRODUÇÃO no ambiente (${prod.join(', ')}) — recusado.`)
  }
  return url.origin
}

/** Base da Graph API (sem versão e sem barra final). Lança LoadTestGateError se o gate falhar. */
export function resolveMetaApiBaseUrl(env: Env = process.env): string {
  return resolveOverride('META_API_BASE_URL', env, META_REAL_BASE, ['facebook.com', 'fbcdn.net'])
}

/** Base da API da OpenAI (sem /v1). Mesmo gate. */
export function resolveOpenAiBaseUrl(env: Env = process.env): string {
  return resolveOverride('OPENAI_BASE_URL', env, OPENAI_REAL_BASE, ['openai.com'])
}

/**
 * Verificação de boot (instrumentation.ts): valida as duas variáveis e o ambiente. Lança se o gate falhar;
 * com a bancada ativa registra um aviso bem visível.
 */
export function assertLoadTestGate(env: Env = process.env, log: Pick<Console, 'warn'> = console): { active: boolean } {
  const meta = resolveMetaApiBaseUrl(env)
  const openai = resolveOpenAiBaseUrl(env)
  if (env.DISPATCH_LOAD_TEST === '1') {
    const prod = supabaseRefsInEnv(env)
    if (prod.length) throw new LoadTestGateError(`DISPATCH_LOAD_TEST=1 com Supabase de PRODUÇÃO (${prod.join(', ')}) — recusado.`)
  }
  const mocked = meta !== META_REAL_BASE || openai !== OPENAI_REAL_BASE
  if (mocked) {
    log.warn(
      `[loadtest] ⚠️⚠️⚠️ BANCADA DE CARGA ATIVA: Meta → ${meta}${openai !== OPENAI_REAL_BASE ? `, OpenAI → ${openai}` : ''}. ` +
        'Mensagens NÃO chegam ao WhatsApp. Use só em staging, com canais/tokens fictícios.',
    )
  }
  return { active: env.DISPATCH_LOAD_TEST === '1' }
}

let openAiBaseCache: string | null = null
/** URL completa de um endpoint da OpenAI (`/chat/completions`, `/audio/transcriptions`…); base lida uma vez. */
export function openAiUrl(path: string): string {
  openAiBaseCache ??= resolveOpenAiBaseUrl()
  return `${openAiBaseCache}/v1${path}`
}

/**
 * baseURL EXPLÍCITO para `new OpenAI({ baseURL })` (SDK oficial, inclui `/v1`). Sem isso o SDK lê OPENAI_BASE_URL
 * sozinho e contorna o gate: uma variável esquecida no .env de produção redirecionaria chamadas (e a chave) para
 * outro host. Aqui a variável só vale com DISPATCH_LOAD_TEST=1 (ENV-04).
 */
export function openAiSdkBaseUrl(env: Env = process.env): string {
  return `${resolveOpenAiBaseUrl(env)}/v1`
}
