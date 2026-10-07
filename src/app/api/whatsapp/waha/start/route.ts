import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { startWahaSession } from '@/lib/whatsapp/waha-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { wahaWebhookFor } from '@/lib/whatsapp/waha-webhook-auth'

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

    if (!profile?.account_id) {
      return NextResponse.json({ error: 'No account linked to user.' }, { status: 403 })
    }

    const body = await request.json().catch(() => ({}))
    const { session: targetSession, id: targetId } = body

    let query = supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', profile.account_id)

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
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 })
  }
}
