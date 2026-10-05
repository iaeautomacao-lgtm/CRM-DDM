import { NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth/account'
import { exchangeInstagramCode, exchangeMessengerCode, verifyOAuthState } from '@/lib/channels/oauth'
import { saveConnectedChannels } from '@/lib/channels/store'

// GET /api/channels/[type]/callback — retorno do OAuth da Meta. Confere o
// state (mesma conta, mesmo usuário, dentro de 10 min), troca o code por
// token, assina os webhooks e grava os canais. Volta para /canais com o
// resultado na query string.

function backToChannels(request: Request, params: Record<string, string>) {
  const url = new URL('/canais', request.url)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return NextResponse.redirect(url)
}

export async function GET(request: Request, { params }: { params: Promise<{ type: string }> }) {
  const { type } = await params
  if (type !== 'instagram' && type !== 'messenger') {
    return NextResponse.json({ error: 'Canal inválido' }, { status: 404 })
  }
  const url = new URL(request.url)
  if (url.searchParams.get('error')) {
    return backToChannels(request, { channel_error: 'Conexão cancelada na Meta' })
  }

  try {
    const { accountId, userId } = await requireRole('admin')
    const state = verifyOAuthState(url.searchParams.get('state'))
    if (!state || state.accountId !== accountId || state.userId !== userId || state.type !== type) {
      return backToChannels(request, { channel_error: 'Sessão de conexão inválida ou expirada' })
    }
    const code = url.searchParams.get('code')
    if (!code) return backToChannels(request, { channel_error: 'A Meta não devolveu o código' })

    const accounts =
      type === 'instagram' ? [await exchangeInstagramCode(code)] : await exchangeMessengerCode(code)
    if (accounts.length === 0) {
      return backToChannels(request, { channel_error: 'Nenhuma página foi liberada na Meta' })
    }
    const { saved, conflicts } = await saveConnectedChannels(accountId, userId, type, accounts)
    return backToChannels(request, {
      channel_connected: type,
      count: String(saved),
      ...(conflicts.length ? { channel_error: `Já conectado em outra conta: ${conflicts.join(', ')}` } : {}),
    })
  } catch (err) {
    console.error(`[channels/${type}/callback] falhou:`, err)
    const message = err instanceof Error ? err.message : 'Falha ao conectar'
    return backToChannels(request, { channel_error: message.slice(0, 200) })
  }
}
