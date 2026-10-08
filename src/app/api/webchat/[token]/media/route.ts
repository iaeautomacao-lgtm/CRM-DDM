import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { chatMediaPath, chatMediaReference } from '@/lib/storage/chat-media'
import { requireActiveSession, webchatError, webchatRateLimit } from '@/lib/webchat/api'

// GET /api/webchat/[token]/media?ref=<referência chat-media>
//
// Abre um anexo para o cliente do Webchat (que não tem login no CRM).
// Só libera um arquivo que:
//   - está na pasta da conta da sessão, e
//   - aparece numa mensagem da conversa de Webchat desta sessão.
// Assim o token não vira acesso ao bucket inteiro da conta. Redireciona
// para uma URL assinada de 5 minutos.

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const limited = await webchatRateLimit(request, token, 'read')
  if (limited) return limited
  const result = await requireActiveSession(token)
  if ('response' in result) return result.response
  const { session } = result
  if (!session.webchat_conversation_id) return webchatError('not_open', 409)

  const ref = new URL(request.url).searchParams.get('ref') ?? ''
  const path = chatMediaPath(ref)
  if (!path || !path.startsWith(`account-${session.account_id}/`) || path.split('/').includes('..')) {
    return webchatError('not_found', 404)
  }

  const db = supabaseAdmin()
  // A mensagem pode guardar a referência estável ou (mensagens antigas) a
  // URL do Storage; aceita qualquer uma das formas do MESMO arquivo.
  const { data: rows } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', session.webchat_conversation_id)
    .in('media_url', [ref, chatMediaReference(path), path])
    .limit(1)
  if (!rows?.length) return webchatError('not_found', 404)

  const { data, error } = await db.storage.from('chat-media').createSignedUrl(path, 300)
  if (error || !data?.signedUrl) return webchatError('not_found', 404)
  const response = NextResponse.redirect(data.signedUrl)
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}
