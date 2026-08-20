import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { authForensicsFetch, logAuthFx } from '@/lib/auth/auth-forensics'

// Singleton instance -- one client shared across the whole browser session.
// Creating multiple clients causes auth-lock contention ("Lock was released
// because another request stole it") and intermittent fetch failures.
let browserClient: SupabaseClient | undefined
let createClientCalls = 0

export function createClient(): SupabaseClient {
  createClientCalls += 1

  if (browserClient) {
    if (typeof window !== "undefined") {
      logAuthFx("CLIENT", { action: "reuse", createClientCalls })
    }
    return browserClient
  }

  if (typeof window !== "undefined") {
    logAuthFx("CLIENT", {
      action: "create",
      createClientCalls,
      supabaseUrlPresent: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      anonKeyPresent: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    })
  }

  browserClient = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: {
        schema: 'wacrm',
      },
      global: {
        fetch: authForensicsFetch,
      },
    }
  ) as any

  return browserClient!
}