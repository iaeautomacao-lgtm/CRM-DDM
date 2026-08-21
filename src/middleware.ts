import { NextResponse, type NextRequest } from 'next/server'

// Derived from the Supabase URL rather than hardcoded, so a different
// project ref per environment (or a future project move) doesn't silently
// break auth. Falls back to the current production ref if the env var is
// somehow unset at request time.
const SUPABASE_PROJECT_REF = (() => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const match = url.match(/^https?:\/\/([^.]+)\./)
  return match ? match[1] : 'mkrkkvbseobdqsalrorl'
})()

const AUTH_COOKIE_NAME = `sb-${SUPABASE_PROJECT_REF}-auth-token`
const BASE64_PREFIX = 'base64-'

function noStore<T extends NextResponse>(response: T): T {
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate'
  )
  return response
}

// Reassembles the (possibly chunked) Supabase auth cookie's raw value.
// @supabase/ssr splits session values over ~3180 bytes across
// `<name>`, `<name>.0`, `<name>.1`, ... rather than storing one big
// cookie (see node_modules/@supabase/ssr/src/utils/chunker.ts) — a
// real session object here routinely crosses that size, so the plain
// unchunked name alone is not enough.
function readAuthCookieRaw(request: NextRequest): string | null {
  const direct = request.cookies.get(AUTH_COOKIE_NAME)?.value
  if (direct) return direct

  const parts: string[] = []
  for (let i = 0; ; i += 1) {
    const chunk = request.cookies.get(`${AUTH_COOKIE_NAME}.${i}`)?.value
    if (!chunk) break
    parts.push(chunk)
  }
  return parts.length > 0 ? parts.join('') : null
}

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8').decode(bytes)
}

// True when the request carries a structurally valid Supabase session
// cookie. This is deliberately NOT a real auth check: it never touches
// the Supabase SDK, so it can never itself trigger a token refresh —
// which is exactly what was racing against the browser SDK's own
// autoRefresh (refresh tokens are single-use; two refreshes racing on
// the same session can invalidate each other).
//
// It also deliberately does NOT check token expiry. An access_token
// that's expired but whose refresh_token is still valid is a normal,
// healthy session — the browser SDK refreshes it client-side, and
// every API route re-validates for real via getCurrentAccount(). Redirecting
// to /login on expiry here would force a needless re-login on any
// fresh page load (new tab, hard refresh, deep link) roughly every
// hour, since the access_token's ~1h lifetime is far shorter than a
// typical session. The only thing worth gating on at this layer is
// "is there a session at all."
function hasSessionCookie(request: NextRequest): boolean {
  const raw = readAuthCookieRaw(request)
  if (!raw) return false
  try {
    const json = raw.startsWith(BASE64_PREFIX)
      ? base64UrlDecode(raw.slice(BASE64_PREFIX.length))
      : raw
    const session = JSON.parse(json)
    return Boolean(
      session &&
        typeof session === 'object' &&
        typeof session.access_token === 'string' &&
        session.access_token.length > 0
    )
  } catch {
    return false
  }
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  const isAuthenticated = hasSessionCookie(request)

  const authFxId = crypto.randomUUID()
  const finalizeAuthFx = <T extends NextResponse>(response: T): T => {
    const isRsc = request.headers.get('rsc') === '1'
    const isPrefetch =
      request.headers.get('next-router-prefetch') === '1' ||
      request.headers.get('purpose') === 'prefetch' ||
      request.headers.get('sec-purpose') === 'prefetch'

    response.headers.set('X-Auth-Fx-Id', authFxId)
    response.headers.set('X-Auth-Fx-Path', pathname)
    response.headers.set('X-Auth-Fx-Mode', 'cookie-only')
    response.headers.set('X-Auth-Fx-Authenticated', isAuthenticated ? '1' : '0')
    response.headers.set('X-Auth-Fx-Rsc', isRsc ? '1' : '0')
    response.headers.set('X-Auth-Fx-Prefetch', isPrefetch ? '1' : '0')
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (isAuthenticated && (
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (pathname === '/login' || pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return finalizeAuthFx(noStore(NextResponse.redirect(url)))
  }

  // Protected pages - redirect to login if not authenticated.
  // '/unauthorized' is deliberately NOT in this list — it must stay
  // reachable without looping back into the role gate below.
  const protectedPaths = [
    '/dashboard',
    '/conversas',
    '/contacts',
    '/pipelines',
    '/flows',
    '/canais',
    '/relatorios',
    '/monitoramento',
    '/disparador',
    '/agente-de-ia',
    '/configuracoes',
    '/automacoes',
    '/settings',
  ]
  if (!isAuthenticated && protectedPaths.some(path => pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'

    // Add debugging parameters to help trace authentication issues on the server/cPanel
    url.searchParams.set('auth_failed', 'true')
    url.searchParams.set('auth_err', 'no_session_cookie')
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      url.searchParams.set('missing_env_url', 'true')
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      url.searchParams.set('missing_env_key', 'true')
    }

    return finalizeAuthFx(noStore(NextResponse.redirect(url)))
  }

  // API routes that need auth (not webhooks). Most other /api/* routes
  // validate for real themselves via getCurrentAccount() — these two
  // prefixes are gated here too because a couple of routes under them
  // (voip-url, external-urls) have no auth check of their own.
  if (!isAuthenticated && pathname.startsWith('/api/whatsapp/') &&
      !pathname.includes('/webhook')) {
    return finalizeAuthFx(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  // Disparador routes need auth too, except /cron which is triggered by an
  // external scheduler authenticating via CRON_SECRET, not a user session.
  if (!isAuthenticated && pathname.startsWith('/api/disparador/') &&
      !pathname.includes('/cron')) {
    return finalizeAuthFx(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return finalizeAuthFx(NextResponse.next())
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff|woff2|ttf|otf)$).*)',
  ],
}
