import { randomUUID } from 'node:crypto'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { MEDIA_MAX_BYTES_BY_KIND } from '@/lib/storage/upload-media'
import {
  requireActiveSession,
  webchatError,
  webchatJson,
  webchatUploadPrefix,
} from '@/lib/webchat/api'
import { WEBCHAT_ALLOWED_MIME, mediaKindFromMime, safeUploadName } from '@/lib/webchat/messages'

const WEBCHAT_MAX_UPLOADS_PER_SESSION = 50

// POST /api/webchat/[token]/upload — autoriza o envio de UM arquivo do
// cliente. Devolve uma URL assinada de upload do Storage (bucket privado
// chat-media) num caminho dentro da pasta da conta e da sessão; o
// navegador sobe o arquivo direto no Storage (sem passar pelo Passenger)
// e depois manda o caminho no POST /messages, que confere o prefixo.

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const result = await requireActiveSession(token)
  if ('response' in result) return result.response
  const { session } = result
  if (!session.webchat_conversation_id) return webchatError('not_open', 409)

  let body: { name?: unknown; mime_type?: unknown; size?: unknown }
  try {
    body = await request.json()
  } catch {
    return webchatError('invalid', 400, 'Corpo inválido')
  }
  const name = typeof body.name === 'string' ? body.name : 'arquivo'
  const mime = typeof body.mime_type === 'string' ? body.mime_type : ''
  const size = typeof body.size === 'number' ? body.size : -1
  if (!WEBCHAT_ALLOWED_MIME.test(mime)) {
    return webchatError('invalid', 400, 'Tipo de arquivo não permitido')
  }
  const maxBytes = MEDIA_MAX_BYTES_BY_KIND[mediaKindFromMime(mime)]
  if (size <= 0 || size > maxBytes) {
    return webchatError('invalid', 400, `Arquivo acima de ${Math.round(maxBytes / 1024 / 1024)} MB`)
  }

  // Teto de arquivos por sessão (24h): o token é público por natureza
  // (vai num link), então limita o quanto ele pode encher o bucket.
  const prefix = webchatUploadPrefix(session)
  const storage = supabaseAdmin().storage.from('chat-media')
  const { data: existing } = await storage.list(prefix.slice(0, -1), {
    limit: WEBCHAT_MAX_UPLOADS_PER_SESSION + 1,
  })
  if ((existing?.length ?? 0) >= WEBCHAT_MAX_UPLOADS_PER_SESSION) {
    return webchatError('rate_limited', 429, 'Limite de arquivos desta conversa atingido')
  }

  const path = `${prefix}${randomUUID()}-${safeUploadName(name)}`
  const { data, error } = await storage.createSignedUploadUrl(path)
  if (error || !data) {
    console.error('[webchat/upload] falha ao gerar URL de upload:', error?.message)
    return webchatJson({ state: 'error', error: 'Não foi possível enviar o arquivo' }, 503)
  }
  return webchatJson({ state: 'active', path: data.path, upload_token: data.token })
}
