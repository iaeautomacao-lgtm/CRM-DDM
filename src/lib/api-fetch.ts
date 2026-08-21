"use client";

/**
 * fetch() wrapper for client components that retries once on a 401.
 *
 * A 401 from an app API route is not, by itself, proof that the
 * browser session is invalid. The server middleware may already have
 * refreshed/rotated cookies for the request while the browser Supabase
 * client is reconciling its local state. Supabase refresh tokens are
 * rotating/single-use, so forcing refreshSession() from every client
 * 401 can steal the refresh token from the middleware (or vice versa)
 * and turn a recoverable stale request into a real client-side
 * SIGNED_OUT event.
 *
 * This wrapper therefore only confirms that the browser client still
 * has a session, then retries once with cookies included. If Supabase
 * itself has already concluded there is no session, callers get the
 * original 401 without an extra refresh attempt.
 */

import { createClient } from "@/lib/supabase/client";

// Coalesce session checks after bursts of concurrent 401s. getSession()
// may update browser auth state if the local session is truly gone, but
// unlike refreshSession() it does not unconditionally consume a rotating
// refresh token merely because one API request was rejected.
let sessionCheckPromise: Promise<boolean> | null = null;

function withCredentials(options?: RequestInit): RequestInit {
  return {
    ...options,
    credentials: options?.credentials ?? "same-origin",
  };
}

async function hasRecoverableBrowserSession(): Promise<boolean> {
  if (!sessionCheckPromise) {
    const supabase = createClient();
    sessionCheckPromise = supabase.auth
      .getSession()
      .then(({ data, error }) => !error && !!data.session)
      .catch(() => false)
      .finally(() => {
        sessionCheckPromise = null;
      });
  }

  return sessionCheckPromise;
}

export async function apiFetch(
  url: string,
  options?: RequestInit,
): Promise<Response> {
  const requestOptions = withCredentials(options);
  const res = await fetch(url, requestOptions);
  if (res.status !== 401) return res;

  const hasSession = await hasRecoverableBrowserSession();
  if (!hasSession) return res;

  // Retry once after the browser client has confirmed a session still
  // exists. If the server still rejects it, return the 401 to the
  // caller without mutating auth state.
  const retryRes = await fetch(url, requestOptions);
  return retryRes;
}
