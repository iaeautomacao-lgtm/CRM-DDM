import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getWahaProfilePicture } from '@/lib/whatsapp/waha-api'
import { safeFetch } from '@/lib/security/ssrf-guard'
import { mediaResponseHeaders, safeInlineContentType } from '@/lib/security/media-proxy'

export async function GET(request: Request) {
  // Qualquer papel da conta (o inbox mostra o avatar a todos); a conta vem da
  // sessão, nunca do query param `account_id` que o front ainda manda.
  let accountId: string
  try {
    accountId = (await getCurrentAccount()).accountId
  } catch (err) {
    return toErrorResponse(err)
  }

  const { searchParams } = new URL(request.url)
  const phone = searchParams.get('phone')

  if (!phone) {
    return NextResponse.json({ error: 'phone é obrigatório' }, { status: 400 })
  }

  const db = supabaseAdmin()

  const { data: config, error: configError } = await db
    .from('whatsapp_config')
    .select('waha_url, waha_session, waha_api_key')
    .eq('account_id', accountId)
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

    // Normaliza o telefone removendo + e espaços
    const normalizedPhone = phone.replace(/^\+/, "").replace(/\s/g, "")
    const avatarUrl = await getWahaProfilePicture(wahaConfig, normalizedPhone)

    if (!avatarUrl) {
      return new NextResponse(null, { status: 404 })
    }

    // Faz proxy da imagem
    // A URL vem do servidor WAHA do tenant: guard anti-SSRF, só image/*.
    const imageRes = await safeFetch(avatarUrl, {}, { maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000 })
    if (!imageRes.ok) {
      return new NextResponse(null, { status: 404 })
    }

    const contentType = imageRes.headers.get('content-type')
    if (!safeInlineContentType(contentType)?.startsWith('image/')) {
      return new NextResponse(null, { status: 404 })
    }
    const imageBuffer = await imageRes.arrayBuffer()

    return new NextResponse(imageBuffer, {
      headers: mediaResponseHeaders(contentType),
    })
  } catch {
    return new NextResponse(null, { status: 500 })
  }
}

