import { requireActiveSession, webchatJson, webchatRateLimit } from '@/lib/webchat/api'
import { openWebchatSession } from '@/lib/webchat/open'

// POST /api/webchat/[token]/open — chamado pela página ao carregar. Na
// primeira vez cria a conversa de Webchat e inicia o fluxo; nas seguintes
// (recarregar a página, outra aba) só confirma. Idempotente.

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const limited = await webchatRateLimit(request, token, 'write')
  if (limited) return limited
  const result = await requireActiveSession(token)
  if ('response' in result) return result.response
  try {
    await openWebchatSession(result.session)
    return webchatJson({ state: 'active', opened: true })
  } catch (err) {
    console.error('[webchat/open] falha ao abrir sessão:', err)
    return webchatJson({ state: 'error', error: 'Não foi possível abrir o atendimento' }, 503)
  }
}
