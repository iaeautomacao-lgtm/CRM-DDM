import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
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
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json().catch(() => ({}))
    const { configId, phone, templateId } = body

    if (!configId || !phone) {
      return NextResponse.json(
        { error: 'configId and phone are required' },
        { status: 400 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('id', configId)
      .eq('account_id', accountId)
      .maybeSingle()

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
        .select('id, name, language')
        .eq('id', templateId)
        .eq('account_id', accountId)
        .maybeSingle()

      if (templateError || !template) {
        return NextResponse.json({ error: 'Template not found' }, { status: 404 })
      }

      try {
        await sendTemplateMessage({
          phoneNumberId: config.phone_number_id,
          accessToken: decrypt(config.access_token),
          to: sanitizedPhone,
          templateName: template.name,
          language: template.language,
          params: [],
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown Meta API error'
        console.error('[channel-test] Meta send failed:', message)
        console.error('[channel-test] Meta error details:', {
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        })
        return NextResponse.json(
          { error: `Meta API error: ${message}` },
          { status: 502 },
        )
      }

      return NextResponse.json({ ok: true, provider: 'meta' })
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
        { error: `WAHA API error: ${message}` },
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
