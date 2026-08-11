import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for the disparador (bulk-send) module.
// Mirrors src/lib/flows/admin-client.ts — same shape so anyone reading
// either file picks up the convention immediately. Lazy init matters here:
// a top-level createClient() call throws "supabaseKey is required" the
// moment Next.js imports the module during build-time page-data collection
// if SUPABASE_SERVICE_ROLE_KEY isn't set in that environment (e.g. CI).
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      {
        db: {
          schema: 'wacrm',
        },
      }
    ) as any
  }
  return _adminClient!
}
