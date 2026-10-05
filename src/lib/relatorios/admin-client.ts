import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { auditFetch } from '@/lib/audit/context'

// Lazy, shared service-role client for the export-history write path
// (storage upload/remove + export_history insert/delete). Mirrors the
// pattern used by src/lib/automations/admin-client.ts,
// src/lib/flows/admin-client.ts, and src/lib/audit/log-event.ts.
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
