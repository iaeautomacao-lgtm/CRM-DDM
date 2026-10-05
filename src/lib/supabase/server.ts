import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { auditFetch, registerAuditActor } from '@/lib/audit/context'

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
  const getUser = client.auth.getUser.bind(client.auth)
  client.auth.getUser = async (...args: Parameters<typeof getUser>) => {
    const result = await getUser(...args)
    if (result.data?.user?.id) await registerAuditActor({ userId: result.data.user.id })
    return result
  }
  return client
}
