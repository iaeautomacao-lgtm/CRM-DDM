import { NextResponse } from 'next/server'
import { requirePermission } from '@/lib/auth/account'
import {
  instagramAuthorizeUrl,
  messengerAuthorizeUrl,
  signOAuthState,
  socialConnectMissingEnv,
} from '@/lib/channels/oauth'

// GET /api/channels/instagram/connect | /api/channels/messenger/connect
// Inicia o OAuth da Meta (owner/admin). O state assinado amarra o callback
// a esta conta e a este usuário.
//
// É uma navegação do navegador (não fetch): qualquer problema volta para
// /canais com a mensagem em ?channel_error= — antes, faltando variável de
// ambiente, o usuário caía numa página com {"error":"Internal server error"}.

function backToChannels(request: Request, message: string) {
  const url = new URL('/canais', request.url)
  url.searchParams.set('channel_error', message)
  return NextResponse.redirect(url)
}

export async function GET(request: Request, { params }: { params: Promise<{ type: string }> }) {
  const { type } = await params
  if (type !== 'instagram' && type !== 'messenger') {
    return backToChannels(request, 'Canal inválido')
  }
  const label = type === 'instagram' ? 'Instagram' : 'Messenger'
  try {
    const { accountId, userId } = await requirePermission('channels.manage')
    const missing = socialConnectMissingEnv(type)
    if (missing.length > 0) {
      return backToChannels(request, `${label} ainda não está configurado no servidor (faltam: ${missing.join(', ')}).`)
    }
    const state = signOAuthState({ accountId, userId, type })
    return NextResponse.redirect(
      type === 'instagram' ? instagramAuthorizeUrl(state) : messengerAuthorizeUrl(state)
    )
  } catch (err) {
    const status = (err as { status?: number })?.status
    if (status === 401) return NextResponse.redirect(new URL('/login', request.url))
    if (status === 403) return backToChannels(request, `Só administradores podem conectar o ${label}.`)
    console.error('[channels/connect] falhou:', err)
    return backToChannels(request, `Não foi possível iniciar a conexão com o ${label}.`)
  }
}
