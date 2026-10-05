import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { auditFetch } from '@/lib/audit/context'

// Lazy, shared service-role client for the Flows engine.
// Mirrors src/lib/automations/admin-client.ts — same shape so anyone
// reading either file picks up the convention immediately.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        db: {
          schema: 'wacrm',
        },
        // Autor/IP da requisição para as triggers de auditoria (migration 131).
        global: { fetch: auditFetch },
      }
    ) as any
  }
  return _adminClient!
}
