import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

function noStore<T extends NextResponse>(response: T): T {
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate'
  )
  return response
}

export async function middleware(request: NextRequest) {
  const authFxId = crypto.randomUUID()
  const setAllActions: string[] = []
  let setAllCount = 0
  let getUserState = 'pending'
  let authErrorName = ''
  let authErrorCode = ''
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: {
        schema: 'wacrm',
      },
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          setAllCount += cookiesToSet.length
          cookiesToSet.forEach(({ name, value, options }) => {
            const expires = options?.expires instanceof Date ? options.expires.getTime() : null
            const action = !value || options?.maxAge === 0 || (expires !== null && expires <= Date.now()) ? 'delete' : 'set'
            setAllActions.push(name + ':' + action)
            request.cookies.set(name, value)
          })
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  ) as any

  let user = null
  let authError = null
  // True only when calling getUser() itself threw (network blip, timeout
  // talking to the auth server, etc.) — NOT when Supabase cleanly
  // returned an error saying the token is invalid/expired. That
  // distinction matters: an explicit AuthApiError means the session is
  // genuinely dead and redirecting to /login (clearing the stale
  // cookie along the way) is correct. An exception here means we don't
  // actually know the auth state — treating that as "logged out" would
  // force a login redirect (and cookie churn) on what might just be a
  // transient hiccup. So only the exception path skips the
  // authenticated/unauthenticated gates below and lets the request
  // through untouched.
  let hadException = false
  try {
    const { data, error } = await supabase.auth.getUser()
    user = data?.user ?? null
    getUserState = user ? 'user' : 'none'
    if (error) {
      authError = error.message
      authErrorName = error.name ?? ''
      authErrorCode = String((error as any).code ?? (error as any).status ?? '')
    }
  } catch (err: any) {
    hadException = true
    getUserState = 'error'
    authError = err.message || 'Unknown auth error'
    authErrorName = err.name ?? ''
    authErrorCode = String(err.code ?? err.status ?? '')
  }

  const isAuthenticated = Boolean(user)

  const finalizeAuthFx = <T extends NextResponse>(response: T): T => {
    const requestCookieNames = request.cookies
      .getAll()
      .map((cookie) => cookie.name)
      .filter((name) => name.startsWith('sb-'))
    const isRsc = request.headers.get('rsc') === '1'
    const isPrefetch =
      request.headers.get('next-router-prefetch') === '1' ||
      request.headers.get('purpose') === 'prefetch' ||
      request.headers.get('sec-purpose') === 'prefetch'

    response.headers.set('X-Auth-Fx-Id', authFxId)
    response.headers.set('X-Auth-Fx-Path', request.nextUrl.pathname)
    response.headers.set('X-Auth-Fx-Rsc', isRsc ? '1' : '0')
    response.headers.set('X-Auth-Fx-Prefetch', isPrefetch ? '1' : '0')
    response.headers.set('X-Auth-Fx-Sb-Count', String(requestCookieNames.length))
    response.headers.set('X-Auth-Fx-GetUser', getUserState)
    response.headers.set('X-Auth-Fx-Error-Name', authErrorName)
    response.headers.set('X-Auth-Fx-Error-Code', authErrorCode)
    response.headers.set('X-Auth-Fx-SetAll-Count', String(setAllCount))
    response.headers.set('X-Auth-Fx-SetAll-Actions', setAllActions.slice(0, 20).join(','))
    response.headers.set('X-Auth-Fx-Next-Url', request.headers.get('next-url') ?? '')
    response.headers.set('X-Auth-Fx-Exception', hadException ? '1' : '0')
    return response
  }
  // getUser() may still cause the SSR client to write refreshed or cleared
  // cookies through setAll(). Any redirect / JSON response below is a fresh
  // object, so copy those Set-Cookie headers onto the response we return.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (isAuthenticated && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return finalizeAuthFx(noStore(withRefreshedCookies(NextResponse.redirect(url))))
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
  if (!isAuthenticated && !hadException && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    
    // Add debugging parameters to help trace authentication issues on the server/cPanel
    url.searchParams.set('auth_failed', 'true')
    if (authError) {
      url.searchParams.set('auth_err', authError)
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
      url.searchParams.set('missing_env_url', 'true')
    }
    if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
      url.searchParams.set('missing_env_key', 'true')
    }
    
    return finalizeAuthFx(noStore(withRefreshedCookies(NextResponse.redirect(url))))
  }

  // API routes that need auth (not webhooks)
  if (!isAuthenticated && !hadException && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return finalizeAuthFx(withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    ))
  }

  // Disparador routes need auth too, except /cron which is triggered by an
  // external scheduler authenticating via CRON_SECRET, not a user session.
  if (!isAuthenticated && !hadException && request.nextUrl.pathname.startsWith('/api/disparador/') &&
      !request.nextUrl.pathname.includes('/cron')) {
    return finalizeAuthFx(withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    ))
  }

  return finalizeAuthFx(supabaseResponse)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff|woff2|ttf|otf)$).*)',
  ],
}
