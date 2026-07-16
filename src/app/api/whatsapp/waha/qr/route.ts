import { createClient } from '@/lib/supabase/server'
import { getWahaQrCode } from '@/lib/whatsapp/waha-api'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function GET(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return new Response('Unauthorized', { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!profile?.account_id) {
      return new Response('Forbidden', { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const targetSession = searchParams.get('session')
    const targetId = searchParams.get('id')

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
      return new Response('WAHA not configured', { status: 400 })
    }

    const config = configs[0]

    const wahaConfig = {
      waha_url: config.waha_url,
      waha_session: config.waha_session,
      waha_api_key: config.waha_api_key ? decrypt(config.waha_api_key) : null,
    }

    const wahaRes = await getWahaQrCode(wahaConfig)
    const contentType = wahaRes.headers.get('content-type') || 'image/png'
    const body = await wahaRes.arrayBuffer()

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'no-store, max-age=0',
      },
    })
  } catch (err: any) {
    console.error('[waha/qr] error:', err)
    return new Response(err.message || 'Internal server error', { status: 500 })
  }
}
