import { NextResponse, after } from 'next/server'
import { registerAuditActor } from '@/lib/audit/context'
import { matchesOperationalSecret } from '@/lib/auth/operational-secret'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { isWellFormedHubSignature, readCappedBody } from '@/lib/security/webhook-body'
import { parseSocialWebhook } from '@/lib/channels/inbound'
import { ingestSocialEvent } from '@/lib/channels/ingest'

// /api/meta/webhook — Instagram (object="instagram") e Messenger
// (object="page"). O WhatsApp continua em /api/whatsapp/webhook.
//
// Configuração no app da Meta:
//   - URL de callback: <NEXT_PUBLIC_APP_URL>/api/meta/webhook
//   - Token de verificação: META_WEBHOOK_VERIFY_TOKEN
//   - Campos: messages, messaging_postbacks
// Assinatura X-Hub-Signature-256: Messenger assina com o App Secret do
// app do Facebook (META_APP_SECRET); Instagram com Instagram Login assina
// com o App Secret do Instagram (INSTAGRAM_APP_SECRET).

export async function GET(request: Request) {
  const url = new URL(request.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')
  if (
    mode === 'subscribe' &&
    challenge &&
    matchesOperationalSecret(process.env.META_WEBHOOK_VERIFY_TOKEN, token)
  ) {
    return new Response(challenge, { status: 200 })
  }
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}

export async function POST(request: Request) {
  // Auditoria: escritas desta requisição saem como "webhook" (webhook_meta_social).
  await registerAuditActor({ actorType: 'webhook', source: 'webhook_meta_social' })
  // SW-5: teto de corpo (Content-Length e leitura do stream).
  const capped = await readCappedBody(request)
  if (!capped.ok) return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  const rawBody = capped.text
  const signature = request.headers.get('x-hub-signature-256')

  // 14.10: o HMAC sobre o BRUTO vem ANTES do JSON.parse. O segredo depende do tipo do evento (Instagram × Messenger), que só se
  // sabe no corpo; por isso confere contra os segredos configurados e só depois parseia e exige o segredo CERTO para o objeto.
  const candidates = [process.env.INSTAGRAM_APP_SECRET, process.env.META_APP_SECRET].filter((s): s is string => !!s)
  const authentic =
    isWellFormedHubSignature(signature) &&
    candidates.some((candidate) => verifyMetaWebhookSignature(rawBody, signature, candidate))
  if (!authentic) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { object?: string }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Mesma regra de antes: Instagram assina com o segredo do Instagram (ou o do app); Messenger só com o do app.
  const secret =
    body.object === 'instagram'
      ? process.env.INSTAGRAM_APP_SECRET ?? process.env.META_APP_SECRET
      : process.env.META_APP_SECRET
  if (!secret || !verifyMetaWebhookSignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const events = parseSocialWebhook(body)
  // Responde rápido (a Meta reenvia se demorar) e processa em after():
  // download de mídia, fluxos e IA rodam depois do 200.
  after(async () => {
    for (const event of events) {
      try {
        await ingestSocialEvent(event)
      } catch (err) {
        console.error('[meta/webhook] falha ao processar evento:', event.type, event.mid, err)
      }
    }
  })
  return NextResponse.json({ received: events.length })
}
