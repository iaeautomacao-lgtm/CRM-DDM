"use client";

/**
 * fetch() wrapper for client components that retries once on a 401.
 *
 * Why: Supabase refresh tokens are rotating/single-use. The browser
 * SDK's own auto-refresh timer and the middleware's on-demand
 * refresh-if-expired (see src/middleware.ts) run as independent
 * processes with no shared coordination — if both attempt to refresh
 * around the same moment, whichever reaches the Auth server second
 * finds its refresh token already consumed by the first, and the
 * request in flight at that exact moment gets a 401 even though the
 * user is genuinely still logged in. Forcing our own refreshSession()
 * call and retrying once recovers from that narrow window without
 * surfacing a spurious "logged out" error to the user.
 *
 * Only reacts to a 401 — every other status (2xx, other 4xx, 5xx) is
 * returned untouched, exactly like a plain fetch().
 */

import { createClient } from "@/lib/supabase/client";

// Serializes refreshSession() across every concurrent apiFetch() call.
// Without this, N requests that all hit a 401 at once each call
// refreshSession() in parallel — since Supabase refresh tokens are
// rotating/single-use, only the first to reach the Auth server
// succeeds and every other concurrent call fails, which is its own
// version of the exact race this wrapper exists to route around.
// Sharing one in-flight promise means only the FIRST 401 triggers a
// refresh; every other concurrent caller just awaits that same
// promise instead of starting its own.
let refreshPromise: Promise<void> | null = null;

export async function apiFetch(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  const res = await fetch(url, options);
  if (res.status !== 401) return res;

  if (!refreshPromise) {
    const supabase = createClient();
    refreshPromise = supabase.auth
      .refreshSession()
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        refreshPromise = null;
      });
  }

  await refreshPromise;

  // Retry once after the (shared) refresh settles — win or lose, we
  // only get one retry per original 401.
  const retryRes = await fetch(url, options);
  if (retryRes.status === 401) {
    throw new Error(
      `apiFetch: still unauthorized after session refresh (${url})`,
    );
  }
  return retryRes;
}
