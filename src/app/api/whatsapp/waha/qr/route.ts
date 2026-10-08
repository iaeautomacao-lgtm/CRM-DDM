import { guardPermission } from '@/lib/auth/route-guard'
import { fetchChannelConfigs } from '@/lib/whatsapp/channel-config'
import { getWahaQrCode } from '@/lib/whatsapp/waha-api'
import { safeInlineContentType, mediaResponseHeaders } from '@/lib/security/media-proxy'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function GET(request: Request) {
  try {
    // Conectar/derrubar/parear o número é decisão de admin: um papel baixo
    // poderia vincular o próprio WhatsApp ao canal e receber as conversas.
    const auth = await guardPermission('channels.manage')
    if (!auth.ok) return auth.response
    const { supabase, accountId } = auth.ctx

    const { searchParams } = new URL(request.url)
    const targetSession = searchParams.get('session')
    const targetId = searchParams.get('id')

    // Segredos (waha_api_key) só pelo servidor (migration 200b); visibilidade = RLS.
    const { data: configs, error: configError } = await fetchChannelConfigs(
      supabase,
      accountId,
      (q) => {
        let query = q.eq('account_id', accountId)
        if (targetId) {
          query = query.eq('id', targetId)
        } else if (targetSession) {
          query = query.eq('waha_session', targetSession)
        }
        return query
      }
    )

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
    // Nunca repassa Content-Type do servidor WAHA (configurável pelo tenant).
    const contentType = safeInlineContentType(wahaRes.headers.get('content-type'))
    if (!contentType?.startsWith('image/')) {
      return new Response('Invalid QR response', { status: 502 })
    }
    const body = await wahaRes.arrayBuffer()

    return new Response(body, {
      status: 200,
      headers: {
        ...mediaResponseHeaders(contentType),
        'Cache-Control': 'no-store, max-age=0',
      },
    })
  } catch (err: any) {
    console.error('[waha/qr] error:', err)
    return new Response('Internal server error', { status: 500 })
  }
}
