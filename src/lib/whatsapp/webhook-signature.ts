import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature Meta attaches to webhook POSTs.
 *
 * Meta signs the raw request body with your App Secret and sends the
 * result in the `x-hub-signature-256: sha256=<hex>` header. Without
 * verification, anyone who knows our webhook URL can POST fabricated
 * status updates and drift broadcast counts arbitrarily.
 *
 * Reference:
 *   https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verify-payloads
 *
 * Contract:
 *   A secret is **required** — either `secretOverride` (the caller's
 *   resolved per-channel `whatsapp_config.app_secret`) or
 *   `META_APP_SECRET`. If neither is available we fail closed — every
 *   request is rejected until the operator configures a secret. A
 *   previous version fell open with a warning log, which is unsafe for
 *   a public template: anyone who forgets the env var would be running
 *   a fully spoofable webhook.
 */
export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
  secretOverride?: string | null,
): boolean {
  const secret = secretOverride ?? process.env.META_APP_SECRET
  if (!secret) {
    console.error(
      '[webhook] No App Secret available (neither a per-channel ' +
        'whatsapp_config.app_secret nor the META_APP_SECRET env var) — ' +
        'rejecting request. Configure one (Meta → App Settings → Basic → ' +
        'App Secret) to enable signature verification.',
    )
    return false
  }

  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
