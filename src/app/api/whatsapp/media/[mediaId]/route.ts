import { NextResponse } from 'next/server'
import { fetchChannelConfigs } from '@/lib/whatsapp/channel-config'
import { ForbiddenError, getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { canAny } from '@/lib/auth/permissions'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'
import { assertWahaUrlIsSafe, WahaUrlBlockedError } from '@/lib/whatsapp/waha-api'
import { safeFetch, SsrfBlockedError } from '@/lib/security/ssrf-guard'
import { mediaResponseHeaders, sanitizeWahaFilePath } from '@/lib/security/media-proxy'

const WAHA_MEDIA_MAX_BYTES = 50 * 1024 * 1024

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params

    if (!mediaId) {
      return NextResponse.json(
        { error: 'ID da mídia é obrigatório' },
        { status: 400 }
      )
    }

    // Mídia de conversa: quem vê conversas (inbox.view ou um escopo de conversas — o visualizador lê conversas sem
    // inbox.view). Contexto completo (revisão de segurança 13/10, item 6): papel personalizado, ajuste do cargo, membro
    // desativado e 2FA. Antes: só sessão.
    let ctx: Awaited<ReturnType<typeof getCurrentAccount>>
    try {
      ctx = await getCurrentAccount()
      if (!canAny(ctx, ['inbox.view', 'conversations.scope_all', 'conversations.scope_team'])) {
        throw new ForbiddenError('Você não tem acesso às conversas.', 'inbox.view')
      }
    } catch (err) {
      return toErrorResponse(err)
    }
    const supabase = ctx.supabase
    const accountId = ctx.accountId

    // WAHA PROXY LOGIC: Stream authenticated files from WAHA server
    if (mediaId === 'waha') {
      const { searchParams } = new URL(request.url)
      const rawFile = searchParams.get('file')
      if (!rawFile) {
        return NextResponse.json(
          { error: 'O parâmetro \'file\' é obrigatório' },
          { status: 400 }
        )
      }
      // Anti path traversal: só <sessão>/<arquivo> com caracteres seguros.
      const file = sanitizeWahaFilePath(rawFile)
      if (!file) {
        return NextResponse.json(
          { error: 'Parâmetro \'file\' inválido' },
          { status: 400 }
        )
      }

      // Fetch active waha config
      // Segredos só pelo servidor (migration 200b); visibilidade = RLS do usuário.
      const { data: wahaRows, error: configError } = await fetchChannelConfigs(
        supabase,
        accountId,
        (q) => q.eq('account_id', accountId).eq('provider', 'waha').limit(1)
      )
      const wahaConfig = (wahaRows?.[0] ?? null) as any

      if (configError || !wahaConfig) {
        return NextResponse.json(
          { error: 'WAHA não configurado' },
          { status: 400 }
        )
      }

      try {
        await assertWahaUrlIsSafe(wahaConfig.waha_url)
      } catch (err) {
        if (err instanceof WahaUrlBlockedError) {
          return NextResponse.json({ error: 'A URL do servidor WAHA não é permitida.' }, { status: 400 })
        }
        throw err
      }

      const apiKey = wahaConfig.waha_api_key ? decrypt(wahaConfig.waha_api_key) : null
      const headers: Record<string, string> = {}
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
        headers['X-Api-Key'] = apiKey
      }

      const baseUrl = wahaConfig.waha_url.replace(/\/$/, '')
      const fileUrl = `${baseUrl}/api/files/${file}`
      let fileRes: Response
      try {
        fileRes = await safeFetch(fileUrl, { headers }, { maxBytes: WAHA_MEDIA_MAX_BYTES, timeoutMs: 30_000 })
      } catch (err) {
        if (err instanceof SsrfBlockedError) {
          return NextResponse.json({ error: 'A URL do servidor WAHA não é permitida.' }, { status: 400 })
        }
        throw err
      }
      if (!fileRes.ok) {
        return NextResponse.json(
          { error: 'Falha ao buscar a mídia no WAHA' },
          { status: fileRes.status }
        )
      }

      const buffer = await fileRes.arrayBuffer()

      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: mediaResponseHeaders(fileRes.headers.get('Content-Type')),
      })
    }

    // Fetch and decrypt WhatsApp config
    // Exatamente 1 canal, como o .single() anterior (vários = erro).
    const { data: configRows, error: configError } = await fetchChannelConfigs(
      supabase,
      accountId,
      (q) => q.eq('account_id', accountId)
    )
    const config = configRows?.length === 1 ? (configRows[0] as any) : null

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp não configurado' },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken })

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: mediaResponseHeaders(contentType || mediaInfo.mimeType),
    })
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error)
    return NextResponse.json(
      { error: 'Falha ao buscar a mídia' },
      { status: 500 }
    )
  }
}
