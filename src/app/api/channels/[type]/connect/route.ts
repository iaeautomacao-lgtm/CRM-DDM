import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { instagramAuthorizeUrl, messengerAuthorizeUrl, signOAuthState } from '@/lib/channels/oauth'

// GET /api/channels/instagram/connect | /api/channels/messenger/connect
// Inicia o OAuth da Meta (owner/admin). O state assinado amarra o callback
// a esta conta e a este usuário.

export async function GET(_request: Request, { params }: { params: Promise<{ type: string }> }) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const { type } = await params
    if (type !== 'instagram' && type !== 'messenger') {
      return NextResponse.json({ error: 'Canal inválido' }, { status: 404 })
    }
    const state = signOAuthState({ accountId, userId, type })
    return NextResponse.redirect(
      type === 'instagram' ? instagramAuthorizeUrl(state) : messengerAuthorizeUrl(state)
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}
