import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getWahaProfilePicture } from '@/lib/whatsapp/waha-api'

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const phone = searchParams.get('phone')
  const account_id = searchParams.get('account_id')

  if (!phone || !account_id) {
    return NextResponse.json({ error: 'phone and account_id required' }, { status: 400 })
  }

  const db = supabaseAdmin()

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('waha_url, waha_session, waha_api_key')
    .eq('account_id', account_id)
    .maybeSingle()

  if (configError || !config) {
    return new NextResponse(null, { status: 404 })
  }

  try {
    const wahaConfig = {
      waha_url: config.waha_url,
      waha_session: config.waha_session,
      waha_api_key: config.waha_api_key ? decrypt(config.waha_api_key) : null,
    }

    const avatarUrl = await getWahaProfilePicture(wahaConfig, phone)

    if (!avatarUrl) {
      return new NextResponse(null, { status: 404 })
    }

    // Faz proxy da imagem
    const imageRes = await fetch(avatarUrl)
    if (!imageRes.ok) {
      return new NextResponse(null, { status: 404 })
    }

    const imageBuffer = await imageRes.arrayBuffer()
    const contentType = imageRes.headers.get('content-type') || 'image/jpeg'

    return new NextResponse(imageBuffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=3600', // cache 1h no browser
      },
    })
  } catch {
    return new NextResponse(null, { status: 500 })
  }
}
