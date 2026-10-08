import { NextResponse } from 'next/server'
import { fetchChannelConfigs } from '@/lib/whatsapp/channel-config'
import { guardPermission } from '@/lib/auth/route-guard'
import { requestWahaPairingCode } from '@/lib/whatsapp/waha-api'
import { decrypt } from '@/lib/whatsapp/encryption'

export async function POST(request: Request) {
  try {
    // Conectar/derrubar/parear o número é decisão de admin: um papel baixo
    // poderia vincular o próprio WhatsApp ao canal e receber as conversas.
    const auth = await guardPermission('channels.manage')
    if (!auth.ok) return auth.response
    const { supabase, accountId } = auth.ctx

    const body = await request.json()
    const { phoneNumber, session: targetSession, configId: targetId } = body

    if (!phoneNumber) {
      return NextResponse.json({ error: 'Phone number is required.' }, { status: 400 })
    }

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
      return NextResponse.json({ error: 'WAHA is not configured.' }, { status: 400 })
    }

    const config = configs[0]

    const wahaConfig = {
      waha_url: config.waha_url,
      waha_session: config.waha_session,
      waha_api_key: config.waha_api_key ? decrypt(config.waha_api_key) : null,
    }

    const cleanPhone = phoneNumber.replace(/\D/g, '')

    const result = await requestWahaPairingCode(wahaConfig, cleanPhone)
    return NextResponse.json({ success: true, code: result.code })
  } catch (err: any) {
    console.error('[waha/pairing-code] error:', err)
    return NextResponse.json({ error: 'Failed to request pairing code' }, { status: 500 })
  }
}
