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

export async function apiFetch(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  const res = await fetch(url, options);
  if (res.status !== 401) return res;

  const supabase = createClient();
  const { data, error } = await supabase.auth.refreshSession();
  if (error || !data.session) {
    // No valid session to retry with — nothing more we can do here.
    // Return the original 401 so the caller's existing error handling
    // (toast, console.error, etc.) still fires, same as before this
    // wrapper existed.
    return res;
  }

  const retryRes = await fetch(url, options);
  if (retryRes.status === 401) {
    throw new Error(
      `apiFetch: still unauthorized after session refresh (${url})`,
    );
  }
  return retryRes;
}
