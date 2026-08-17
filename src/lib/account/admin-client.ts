import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for account/member management that
// needs to cross RLS (creating auth users, moving profiles between
// accounts). Mirrors src/lib/flows/admin-client.ts — same shape so
// anyone reading either file picks up the convention immediately.
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
