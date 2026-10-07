import { NextResponse } from 'next/server'
import { guardRole } from '@/lib/auth/route-guard'
import { startWahaSession } from '@/lib/whatsapp/waha-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { wahaWebhookFor } from '@/lib/whatsapp/waha-webhook-auth'

export async function POST(request: Request) {
  try {
    // Conectar/derrubar/parear o número é decisão de admin: um papel baixo
    // poderia vincular o próprio WhatsApp ao canal e receber as conversas.
    const auth = await guardRole('admin')
    if (!auth.ok) return auth.response
    const { supabase, accountId } = auth.ctx

    const body = await request.json().catch(() => ({}))
    const { session: targetSession, id: targetId } = body

    let query = supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)

    if (targetId) {
      query = query.eq('id', targetId)
    } else if (targetSession) {
      query = query.eq('waha_session', targetSession)
    }

    const { data: configs, error: configError } = await query

    if (configError || !configs || configs.length === 0 || configs[0].provider !== 'waha') {
      return NextResponse.json({ error: 'WAHA is not configured.' }, { status: 400 })
    }

    const config = configs[0]

    const wahaConfig = {
      waha_url: config.waha_url,
      waha_session: config.waha_session,
      waha_api_key: config.waha_api_key ? decrypt(config.waha_api_key) : null,
    }

    // URL do webhook a partir de env confiável (nunca de Host/X-Forwarded-Host)
    // e segredo derivado por canal — o segredo global não vai para o WAHA.
    await startWahaSession(wahaConfig, wahaWebhookFor(config.id))
    return NextResponse.json({ success: true, message: 'WAHA session start requested.' })
  } catch (err: any) {
    console.error('[waha/start] error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
