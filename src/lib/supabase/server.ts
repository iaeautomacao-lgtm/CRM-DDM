import "server-only";
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { auditFetch, registerAuditActor } from '@/lib/audit/context'
import { aalFromAccessToken, isMfaRequired, MFA_REQUIRED_CODE } from '@/lib/auth/mfa'

export async function createClient() {
  const cookieStore = await cookies()

  const client = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: {
        schema: 'wacrm',
      },
      // Autor/IP da requisição para as triggers de auditoria (migration 131).
      global: { fetch: auditFetch },
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing sessions.
          }
        },
      },
    }
  ) as any

  // getUser() valida o JWT no servidor de auth: a partir daí o usuário é o
  // autor das escritas desta requisição (ver src/lib/audit/context.ts).
  //
  // 2FA obrigatório (src/lib/auth/mfa.ts): usuário com fator TOTP verificado e
  // sessão aal1 (só senha) NÃO conta como logado no servidor — getUser devolve
  // user null e um erro com code 'mfa_required'. Vale para getCurrentAccount e
  // para toda rota que chama getUser direto, sem exceção por rota.
  const getUser = client.auth.getUser.bind(client.auth)
  client.auth.getUser = async (...args: Parameters<typeof getUser>) => {
    const result = await getUser(...args)
    const user = result.data?.user
    if (user?.id && Array.isArray(user.factors) && user.factors.length > 0) {
      const token =
        typeof args[0] === 'string' ? args[0] : (await client.auth.getSession()).data?.session?.access_token
      if (isMfaRequired(user.factors, aalFromAccessToken(token))) {
        return {
          data: { user: null },
          error: Object.assign(new Error('Confirme o código de verificação em duas etapas.'), {
            name: 'AuthMfaRequiredError',
            code: MFA_REQUIRED_CODE,
            status: 401,
          }),
        }
      }
    }
    if (user?.id) await registerAuditActor({ userId: user.id })
    return result
  }
  return client
}
