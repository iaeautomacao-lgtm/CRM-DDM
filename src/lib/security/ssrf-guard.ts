import { isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'

/**
 * Guard único contra SSRF. Todo fetch de URL controlada por usuário/tenant
 * (nó http_fetch, tools HTTP da IA, send_webhook, callback_url, header de
 * template, waha_url) passa por aqui.
 *
 * - só http/https;
 * - resolve o DNS e bloqueia IP privado/loopback/link-local/metadata/CGNAT/
 *   multicast/reservado (IPv4 e IPv6, incl. IPv4 embutido em ::ffff:, NAT64,
 *   6to4) — falha de DNS = bloqueio (fail-closed);
 * - `safeFetch` conecta no IP já validado (a validação acontece dentro do
 *   `lookup` do socket → sem janela para DNS rebinding);
 * - redirects manuais, revalidados a cada salto (máx. 3);
 * - timeout e limite de tamanho da resposta.
 *
 * Hosts internos legítimos: env `SSRF_ALLOWED_HOSTS` (lista separada por
 * vírgula, hostname exato ou `*.dominio`). Host na allowlist pula o bloqueio
 * de IP, mas continua restrito a http/https.
 */

export type SsrfBlockReason =
  | 'invalid_url'
  | 'protocol'
  | 'credentials'
  | 'blocked_host'
  | 'blocked_ip'
  | 'dns_failure'
  | 'too_many_redirects'
  | 'response_too_large'
  | 'timeout'
  | 'cross_origin_redirect'

export class SsrfBlockedError extends Error {
  readonly reason: SsrfBlockReason
  constructor(reason: SsrfBlockReason, message?: string) {
    super(message ?? `URL não permitida (${reason}).`)
    this.name = 'SsrfBlockedError'
    this.reason = reason
  }
}

export const SSRF_MAX_REDIRECTS = 3
export const SSRF_DEFAULT_TIMEOUT_MS = 15_000
export const SSRF_DEFAULT_MAX_BYTES = 2 * 1024 * 1024

// ── IP ──────────────────────────────────────────────────────────────

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

// [base, bits]
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local + metadata 169.254.169.254
  ['172.16.0.0', 12],
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reservado + broadcast
]

function isBlockedIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip)
  if (n === null) return true // não parseável → bloqueia
  return BLOCKED_V4.some(([base, bits]) => {
    const b = ipv4ToInt(base)!
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return ((n & mask) >>> 0) === ((b & mask) >>> 0)
  })
}

/** Expande IPv6 para 8 grupos de 16 bits; null se inválido. */
function parseIPv6(input: string): number[] | null {
  let ip = input.toLowerCase()
  const zone = ip.indexOf('%')
  if (zone >= 0) ip = ip.slice(0, zone)

  // IPv4 dotted no final (::ffff:1.2.3.4) → converte em 2 grupos hex
  const lastColon = ip.lastIndexOf(':')
  const tail = ip.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail)
    if (v4 === null) return null
    ip =
      ip.slice(0, lastColon + 1) +
      ((v4 >>> 16) & 0xffff).toString(16) +
      ':' +
      (v4 & 0xffff).toString(16)
  }

  const halves = ip.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  let groups: string[]
  if (halves.length === 2) {
    const missing = 8 - head.length - rest.length
    if (missing < 1) return null
    groups = [...head, ...Array(missing).fill('0'), ...rest]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  const out: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    out.push(parseInt(g, 16))
  }
  return out
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

function isBlockedIPv6(ip: string): boolean {
  const g = parseIPv6(ip)
  if (!g) return true
  const [a, b, c, d, e, f, g6, h] = g

  // :: e ::1
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g6 === 0 && (h === 0 || h === 1)) {
    return true
  }
  // ::ffff:0:0/96 (IPv4-mapped, também as formas hex ::ffff:7f00:1)
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return isBlockedIPv4(v4FromGroups(g6, h))
  }
  // ::/96 (IPv4-compatible, obsoleto) e ::ffff:0:x:y (SIIT)
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) {
    return isBlockedIPv4(v4FromGroups(g6, h))
  }
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0xffff && f === 0) {
    return isBlockedIPv4(v4FromGroups(g6, h))
  }
  // 64:ff9b::/96 (NAT64) → IPv4 embutido
  if (a === 0x64 && b === 0xff9b && c === 0 && d === 0 && e === 0 && f === 0) {
    return isBlockedIPv4(v4FromGroups(g6, h))
  }
  // 64:ff9b:1::/48 (NAT64 local)
  if (a === 0x64 && b === 0xff9b && c === 1) return true
  // 2002::/16 (6to4) → IPv4 nos grupos 2-3
  if (a === 0x2002) return isBlockedIPv4(v4FromGroups(b, c))
  // 2001::/32 (Teredo) e 2001:db8::/32 (documentação)
  if (a === 0x2001 && (b === 0 || b === 0x0db8)) return true
  // 100::/64 (discard)
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return true
  if ((a & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((a & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((a & 0xffc0) === 0xfec0) return true // fec0::/10 site-local
  if ((a & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

/** true se o IP (v4/v6 em texto) está em faixa não pública. Inválido = true. */
export function isBlockedIp(ip: string): boolean {
  const clean = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip
  const kind = isIP(clean)
  if (kind === 4) return isBlockedIPv4(clean)
  if (kind === 6) return isBlockedIPv6(clean)
  return true
}

// ── Allowlist ───────────────────────────────────────────────────────

function allowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.SSRF_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

function isHostAllowlisted(hostname: string, env?: NodeJS.ProcessEnv): boolean {
  const host = hostname.toLowerCase()
  return allowedHosts(env).some((entry) =>
    entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry,
  )
}

// ── Validação de URL ────────────────────────────────────────────────

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function parseHttpUrl(raw: string | URL): URL {
  let url: URL
  try {
    url = raw instanceof URL ? raw : new URL(raw)
  } catch {
    throw new SsrfBlockedError('invalid_url')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfBlockedError('protocol')
  }
  if (url.username || url.password) throw new SsrfBlockedError('credentials')
  return url
}

type Resolved = { address: string; family: 4 | 6 }

/**
 * Resolve e valida o host. Devolve o IP a ser usado na conexão. Host na
 * allowlist é resolvido sem filtro de faixa.
 */
async function resolveAndValidate(
  hostnameRaw: string,
  env?: NodeJS.ProcessEnv,
  resolver: typeof dnsLookup = dnsLookup,
): Promise<Resolved> {
  const hostname = stripBrackets(hostnameRaw).toLowerCase().replace(/\.$/, '')
  const allowlisted = isHostAllowlisted(hostname, env)

  const literal = isIP(hostname)
  if (literal) {
    if (!allowlisted && isBlockedIp(hostname)) throw new SsrfBlockedError('blocked_ip')
    return { address: hostname, family: literal as 4 | 6 }
  }

  if (!allowlisted && (hostname === 'localhost' || hostname.endsWith('.localhost'))) {
    throw new SsrfBlockedError('blocked_host')
  }

  let results: Array<{ address: string; family: number }>
  try {
    results = await resolver(hostname, { all: true, verbatim: true })
  } catch {
    throw new SsrfBlockedError('dns_failure')
  }
  if (!results.length) throw new SsrfBlockedError('dns_failure')
  if (!allowlisted && results.some((r) => isBlockedIp(r.address))) {
    throw new SsrfBlockedError('blocked_ip')
  }
  const first = results[0]
  return { address: first.address, family: first.family === 6 ? 6 : 4 }
}

/**
 * Valida a URL sem buscar nada (uso na criação: callback_url, waha_url,
 * webhook). Retorna a URL parseada. Lança SsrfBlockedError.
 */
export async function assertPublicUrl(raw: string | URL): Promise<URL> {
  const url = parseHttpUrl(raw)
  await resolveAndValidate(url.hostname)
  return url
}

// ── safeFetch ───────────────────────────────────────────────────────

export interface SafeFetchOptions {
  timeoutMs?: number
  maxBytes?: number
  maxRedirects?: number
  /**
   * Redirect para OUTRA origem vira erro (em vez de seguir): usado quando a
   * requisição carrega credencial (header custom, query ou body) — o guard só
   * remove 4 headers conhecidos no cross-origin e não sabe qual campo é segredo.
   */
  failOnCrossOriginRedirect?: boolean
  /** Só para testes. */
  env?: NodeJS.ProcessEnv
  /** Só para testes. */
  resolver?: typeof dnsLookup
}

type SafeFetchInit = {
  method?: string
  headers?: HeadersInit
  body?: string | Uint8Array | null
  signal?: AbortSignal
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])
const CROSS_ORIGIN_STRIP = ['authorization', 'cookie', 'x-api-key', 'proxy-authorization']

function requestOnce(
  url: URL,
  resolved: Resolved,
  method: string,
  headers: Headers,
  body: string | Uint8Array | undefined,
  opts: Required<Pick<SafeFetchOptions, 'timeoutMs' | 'maxBytes'>>,
  outerSignal?: AbortSignal,
): Promise<{ status: number; headers: Headers; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const flat: Record<string, string> = {}
    headers.forEach((v, k) => {
      flat[k] = v
    })

    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      outerSignal?.removeEventListener('abort', onAbort)
      fn()
    }

    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: stripBrackets(url.hostname),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        headers: flat,
        // Conecta SEMPRE no IP já validado; o hostname segue valendo para
        // SNI/Host. Aceita as duas assinaturas do lookup (all: true no Node 20).
        lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => {
          if (o?.all) cb(null, [{ address: resolved.address, family: resolved.family }])
          else cb(null, resolved.address, resolved.family)
        }) as never,
      },
      (res) => {
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (chunk: Buffer) => {
          total += chunk.length
          if (total > opts.maxBytes) {
            req.destroy()
            done(() => reject(new SsrfBlockedError('response_too_large')))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const h = new Headers()
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => h.append(k, x))
            else if (v !== undefined) h.set(k, v)
          }
          done(() => resolve({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks) }))
        })
        res.on('error', (e) => done(() => reject(e)))
      },
    )

    const onAbort = () => {
      req.destroy()
      done(() => reject(new SsrfBlockedError('timeout', 'Requisição cancelada.')))
    }
    const timer = setTimeout(() => {
      req.destroy()
      done(() => reject(new SsrfBlockedError('timeout', 'Tempo limite excedido.')))
    }, opts.timeoutMs)
    if (outerSignal) {
      if (outerSignal.aborted) return onAbort()
      outerSignal.addEventListener('abort', onAbort, { once: true })
    }

    req.on('error', (e) => done(() => reject(e)))
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/**
 * fetch protegido contra SSRF. Retorna um `Response` padrão (corpo já
 * lido, limitado a `maxBytes`). Lança SsrfBlockedError quando bloqueado.
 */
export async function safeFetch(
  input: string | URL,
  init: SafeFetchInit = {},
  options: SafeFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? SSRF_DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? SSRF_DEFAULT_MAX_BYTES
  const maxRedirects = options.maxRedirects ?? SSRF_MAX_REDIRECTS

  let url = parseHttpUrl(input)
  let method = (init.method ?? 'GET').toUpperCase()
  let body: string | Uint8Array | undefined = init.body ?? undefined
  const headers = new Headers(init.headers)
  if (method === 'GET' || method === 'HEAD') body = undefined
  if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity')
  const deadline = Date.now() + timeoutMs

  for (let hop = 0; ; hop++) {
    const resolved = await resolveAndValidate(url.hostname, options.env, options.resolver)
    const remaining = Math.max(1, deadline - Date.now())
    const res = await requestOnce(url, resolved, method, headers, body, { timeoutMs: remaining, maxBytes }, init.signal)

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location')
      if (!location) return toResponse(res)
      if (hop >= maxRedirects) throw new SsrfBlockedError('too_many_redirects')
      const next = parseHttpUrl(new URL(location, url))
      if (next.origin !== url.origin) {
        if (options.failOnCrossOriginRedirect) throw new SsrfBlockedError('cross_origin_redirect')
        for (const h of CROSS_ORIGIN_STRIP) headers.delete(h)
      }
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
        headers.delete('content-type')
        headers.delete('content-length')
      }
      url = next
      continue
    }
    return toResponse(res)
  }
}

function toResponse(res: { status: number; headers: Headers; body: Buffer }): Response {
  // O corpo já vem descompactado pelo servidor? Não: não pedimos
  // accept-encoding, então o upstream responde sem compressão.
  const h = new Headers(res.headers)
  h.delete('content-length')
  h.delete('content-encoding')
  h.delete('transfer-encoding')
  return new Response(NULL_BODY_STATUSES.has(res.status) ? null : new Uint8Array(res.body), {
    status: res.status,
    headers: h,
  })
}
