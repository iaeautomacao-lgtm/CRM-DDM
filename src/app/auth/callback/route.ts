import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  // se "next" for informado, redireciona para lá, senão vai para a home do dashboard
  const next = searchParams.get('next') ?? '/dashboard'

  if (code) {
    const cookieStore = await cookies()
    // Anon key, not service role — exchangeCodeForSession is an Auth
    // operation, not a data query, so it doesn't go through RLS and
    // gains nothing from an elevated key. Same getAll/setAll cookie
    // adapter as lib/supabase/server.ts, so this route's session
    // cookies round-trip identically to every other server client in
    // the app instead of going through the deprecated get/set/remove
    // shape.
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          },
        },
      }
    )
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  // Se houver algum erro, redireciona para a página de login
  return NextResponse.redirect(`${origin}/login?error=auth-callback-failed`)
}
