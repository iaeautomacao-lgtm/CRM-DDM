import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { safeReturnPath } from '@/lib/auth/return-path'
import { callbackFailurePath } from '@/lib/auth/recovery-link'
import { sessionCookieOptions } from '@/lib/supabase/cookie-options'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  // se "next" for informado, redireciona para lá, senão vai para a home do dashboard
  const next = safeReturnPath(searchParams.get('next'))
  // Link de definição de senha gerado pelo SERVIDOR (convite em lote — revisão de segurança 13/10): não tem o PKCE do
  // navegador, então vem como token_hash + type e é verificado aqui (padrão do Supabase para SSR). Só 'recovery'.
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type')

  if (code || (tokenHash && type === 'recovery')) {
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
        cookieOptions: sessionCookieOptions(),
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
    const { error } = code
      ? await supabase.auth.exchangeCodeForSession(code)
      : await supabase.auth.verifyOtp({ type: 'recovery', token_hash: tokenHash as string })
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
  }

  // Se houver algum erro (link vencido, já usado ou sem código):
  // recuperação de senha volta para /reset-password, que explica e
  // oferece pedir outro link; o resto vai para o login.
  return NextResponse.redirect(`${origin}${callbackFailurePath(next)}`)
}
