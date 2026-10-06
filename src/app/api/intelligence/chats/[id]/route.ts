import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getOwnedChat, loadChatMessages } from '@/lib/intelligence/chat/store'
import { currentIntelligenceScope, intelligenceErrorResponse } from '@/lib/intelligence/http'

// GET /api/intelligence/chats/[id] — mensagens de um chat do PRÓPRIO
// usuário. Chat de outro usuário (ou de outra conta) responde 404.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const scope = await currentIntelligenceScope()
    const { id } = await params
    if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })
    const db = supabaseAdmin()
    const chat = await getOwnedChat(db, scope, id.toLowerCase())
    if (!chat) return NextResponse.json({ error: 'Conversa não encontrada' }, { status: 404 })
    const messages = await loadChatMessages(db, chat.id)
    return NextResponse.json({ chat, messages })
  } catch (err) {
    return intelligenceErrorResponse(err)
  }
}
