import { NextResponse } from 'next/server'
import { fetchChannelConfigs } from '@/lib/whatsapp/channel-config'
import { guardRole } from '@/lib/auth/route-guard'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { sendWahaTextMessage } from '@/lib/whatsapp/waha-api'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'

/**
 * POST /api/whatsapp/channel-test
 *
 * Fires a one-off test message at a WAHA channel so a user can verify
 * a connection works without leaving a trace in the inbox — no
 * conversation/message row is created, unlike /api/whatsapp/send.
 * Meta channels can't be tested this way (no approved template to
 * send with), so they get a structured "not supported" response
 * instead of attempting a Cloud API call.
 */
export async function POST(request: Request) {
  try {
    // Templates/canais mexem no WABA da conta (Meta) ou no número conectado: só admin
    // (mesmo papel das páginas /templates e /canais).
    const auth = await guardRole('admin')
    if (!auth.ok) return auth.response
    const { supabase, accountId } = auth.ctx

    // O orçamento é compartilhado por todos os administradores da conta.
    const limit = checkRateLimit(`channel-test:${accountId}`, { limit: 10, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => ({}))
    const { configId, phone, templateId, params: bodyParams } = body

    if (!configId || !phone) {
      return NextResponse.json(
        { error: 'configId and phone are required' },
        { status: 400 },
      )
    }

    // Segredos só pelo servidor (migration 200b); visibilidade = RLS do usuário.
    const { data: configRows, error: configError } = await fetchChannelConfigs(
      supabase,
      accountId,
      (q) => q.eq('id', configId).eq('account_id', accountId),
    )
    const config = (configRows?.[0] ?? null) as any

    if (configError || !config) {
      return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
    }

    const sanitizedPhone = sanitizePhoneForMeta(phone)
    if (!isValidE164(sanitizedPhone)) {
      return NextResponse.json(
        { error: 'Invalid phone number format' },
        { status: 400 },
      )
    }

    if (config.provider === 'meta') {
      if (!templateId) {
        return NextResponse.json({
          ok: false,
          provider: 'meta',
          reason: 'template_required',
          message:
            'Canais Meta exigem template aprovado para enviar mensagens. Use a aba Templates para criar e aprovar um template primeiro.',
        })
      }

      const { data: template, error: templateError } = await supabase
        .from('message_templates')
        .select('id, name, language, body_text')
        .eq('id', templateId)
        .eq('account_id', accountId)
        .maybeSingle()

      if (templateError || !template) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 })
      }

      let messageId: string
      try {
        const result = await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken: decrypt(config.access_token),
          to: sanitizedPhone,
          templateName: template.name,
          language: template.language,
          params: Array.isArray(bodyParams) ? bodyParams.map(String) : [],
        })
        messageId = result.messageId
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown Meta API error'
        console.error('[channel-test] Meta send failed:', message)
        console.error('[channel-test] Meta error details:', {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        })
        return NextResponse.json(
          { error: 'Falha ao enviar o teste pela Meta. Confira o canal e o template.' },
          { status: 502 },
        )
      }

      // Tracked in whatsapp_test_sends (not `messages` — this send
      // deliberately has no conversation, see this file's docstring)
      // so the dialog can poll for the real delivered/read/failed
      // status the webhook mirrors in later. Best-effort: a failed
      // insert here just means the dialog's poll times out instead
      // of resolving — it must not fail the test send itself.
      const { error: trackError } = await supabase
        .from('whatsapp_test_sends')
        .insert({ account_id: accountId, config_id: configId, message_id: messageId })
      if (trackError) {
        console.error('[channel-test] Failed to track test send:', trackError)
      }

      return NextResponse.json({ ok: true, provider: 'meta', messageId })
    }

    const wahaConfig = {
      waha_url: config.waha_url,
      waha_session: config.waha_session,
      waha_api_key: config.waha_api_key ? decrypt(config.waha_api_key) : null,
    }

    const text = `🔧 Teste de conexão — CRM DDM\n${new Date().toISOString()}`

    try {
      await sendWahaTextMessage(wahaConfig, sanitizedPhone, text)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown WAHA API error'
      console.error('[channel-test] WAHA send failed:', message)
      return NextResponse.json(
        { error: 'Falha ao enviar o teste pelo WAHA. Confira se a sessão está conectada.' },
        { status: 502 },
      )
    }

    return NextResponse.json({ ok: true, provider: 'waha' })
  } catch (error) {
    console.error('Error in WhatsApp channel-test POST:', error)
    return NextResponse.json(
      { error: 'Failed to test channel' },
      { status: 500 },
    )
  }
}
