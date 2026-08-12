import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

// Singleton instance — one client shared across the whole browser session.
// Creating multiple clients causes auth-lock contention ("Lock was released
// because another request stole it") and intermittent fetch failures.
let browserClient: SupabaseClient | undefined

export function createClient(): SupabaseClient {
  if (browserClient) return browserClient

  if (typeof window !== "undefined") {
    console.log("[createClient] NEXT_PUBLIC_SUPABASE_URL:", process.env.NEXT_PUBLIC_SUPABASE_URL);
    console.log("[createClient] NEXT_PUBLIC_SUPABASE_ANON_KEY present:", !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  }

  browserClient = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: {
        schema: 'wacrm',
      },
    }
  ) as any

  return browserClient!
}
