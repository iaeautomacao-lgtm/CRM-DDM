// Base das URLs de convite — FALHA FECHADO (TASK29 / ENV-09 / AP-14).
//
// O link de convite carrega um token de acesso à conta. Se o host do link viesse do cabeçalho `Host` /
// `X-Forwarded-Host` da requisição (que o chamador controla) ou de um padrão fixo (`wacrm.tech`), um POST direto
// com `Host: phishing.example` receberia um convite apontando para o site do atacante.
//
// Regra: o host do link só pode vir de configuração do servidor:
//   1. URL do app — NEXT_PUBLIC_APP_URL (alias legado: NEXT_PUBLIC_SITE_URL). Vence sempre.
//   2. ALLOWED_INVITE_HOSTS (lista separada por vírgula, host[:porta]). Com UM host, ele é usado. Com vários, a
//      requisição só ESCOLHE entre eles (o host do cabeçalho precisa constar da lista; o link sai com o texto da
//      LISTA, nunca com o do cabeçalho). Host fora da lista → erro.
//   3. Nada configurado → erro claro. Nunca um link para host arbitrário.

type Env = Record<string, string | undefined>

export class InviteBaseUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InviteBaseUrlError'
  }
}

const NOT_CONFIGURED =
  'Convites indisponíveis: o servidor não tem a URL do app configurada. Defina NEXT_PUBLIC_APP_URL (ou ALLOWED_INVITE_HOSTS) e refaça o build/reinício.'

function parseAllowedHosts(env: Env): string[] {
  return (env.ALLOWED_INVITE_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

function isLocalHost(host: string): boolean {
  const name = host.split(':')[0]
  return name === 'localhost' || name === '127.0.0.1'
}

function appUrlOrigin(env: Env): string | null {
  const raw = [env.NEXT_PUBLIC_APP_URL, env.NEXT_PUBLIC_SITE_URL].map((v) => v?.trim()).find((v) => !!v)
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

function requestHost(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim().toLowerCase()
  const host = request.headers.get('host')?.trim().toLowerCase()
  return forwarded || host || null
}

/** Base (sem barra final) para montar o link de convite. Lança InviteBaseUrlError se não houver host confiável. */
export function resolveInviteBaseUrl(request: Request, env: Env = process.env): string {
  const app = appUrlOrigin(env)
  if (app) return app

  const allowed = parseAllowedHosts(env)
  if (allowed.length === 0) throw new InviteBaseUrlError(NOT_CONFIGURED)

  let chosen: string | undefined
  if (allowed.length === 1) {
    chosen = allowed[0]
  } else {
    const asked = requestHost(request)
    chosen = asked ? allowed.find((h) => h === asked) : undefined
  }
  if (!chosen) {
    throw new InviteBaseUrlError(
      'Convite recusado: o host da requisição não está em ALLOWED_INVITE_HOSTS. Acesse pelo endereço oficial do app.',
    )
  }
  return `${isLocalHost(chosen) ? 'http' : 'https'}://${chosen}`
}
