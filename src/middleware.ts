import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { canAccessRoute, getDefaultRoute, type UserRole } from '@/lib/role-utils'

function noStore<T extends NextResponse>(response: T): T {
  response.headers.set(
    'Cache-Control',
    'private, no-store, no-cache, max-age=0, must-revalidate'
  )
  return response
}

export async function middleware(request: NextRequest) {
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
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  ) as any

  let user = null
  let userId: string | null = null
  let authError = null
  try {
    const { data, error } = await supabase.auth.getUser()
    user = data?.user ?? null
    userId = user?.id ?? null
    if (error) {
      authError = error.message
    }
  } catch (err: any) {
    authError = err.message || 'Unknown auth error'
  }

  const isAuthenticated = Boolean(user)

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
    return noStore(withRefreshedCookies(NextResponse.redirect(url)))
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
  if (!isAuthenticated && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
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
    
    return noStore(withRefreshedCookies(NextResponse.redirect(url)))
  }

  // Role-based route gating (RBAC) — layered on top of the auth check
  // above, not a replacement for it. Only runs for signed-in users on
  // a protected path. The role lives on `profiles.account_role`
  // (there is no separate account_members table); the `supabase`
  // client above is already scoped to the `wacrm` schema.
  if (userId && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const { data: roleRow, error: roleError } = await supabase
      .from('profiles')
      .select('account_role')
      .eq('user_id', userId)
      .maybeSingle()

    const role = (roleRow?.account_role ?? null) as UserRole | null

    if (roleError || !role) {
      const url = request.nextUrl.clone()
      url.pathname = '/unauthorized'
      url.search = ''
      return noStore(withRefreshedCookies(NextResponse.redirect(url)))
    }

    if (!canAccessRoute(role, request.nextUrl.pathname)) {
      const url = request.nextUrl.clone()
      url.pathname = getDefaultRoute(role)
      url.search = ''
      return noStore(withRefreshedCookies(NextResponse.redirect(url)))
    }
  }

  // API routes that need auth (not webhooks)
  if (!isAuthenticated && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  // Disparador routes need auth too, except /cron which is triggered by an
  // external scheduler authenticating via CRON_SECRET, not a user session.
  if (!isAuthenticated && request.nextUrl.pathname.startsWith('/api/disparador/') &&
      !request.nextUrl.pathname.includes('/cron')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
