/** Return navigation is convenience only; destination authorization still applies. */
export function safeReturnPath(
  raw: string | null | undefined,
  fallback = '/dashboard'
): string {
  if (
    !raw?.startsWith('/') ||
    raw.startsWith('//') ||
    /[\\\u0000-\u001f]/.test(raw)
  )
    return fallback;
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.startsWith('//') || decoded.includes('\\')) return fallback;
    const url = new URL(raw, 'https://crm.invalid');
    if (url.origin !== 'https://crm.invalid') return fallback;
    if (
      /^\/(?:api|auth|login|signup|forgot-password)(?:\/|$)/.test(url.pathname)
    )
      return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
