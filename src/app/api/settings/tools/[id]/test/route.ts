import { NextResponse } from 'next/server'
import { guardPermission } from '@/lib/auth/route-guard'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadAccountSecrets } from '@/lib/ai/account-secrets'
import { safeFetch, SsrfBlockedError } from '@/lib/security/ssrf-guard'
import { checkRateLimit } from '@/lib/rate-limit'
import { buildToolRequest, exampleArguments, sanitizeResponseBody } from '@/lib/ai-tools/tool-request'
import { toolTimeoutMs, type ToolRow } from '@/lib/ai-tools/tool-input'

// POST /api/settings/tools/[id]/test — "Testar ferramenta" (owner/admin).
//
// Executa a ferramenta com argumentos de exemplo (ou os enviados) pelo MESMO
// caminho do agente (segredos antes dos argumentos, host checado na URL
// final, safeFetch com guard anti-SSRF e redirect cross-origin bloqueado
// quando há credencial). Devolve SÓ o status HTTP e até 2 KB do corpo
// SANITIZADO (valores de credenciais trocados por ***): nunca a URL, os
// headers ou o body resolvidos.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const auth = await guardPermission('ai.tools.edit')
  if (!auth.ok) return auth.response
  const { accountId, userId } = auth.ctx
  if (!UUID.test(id)) return NextResponse.json({ error: 'Não encontrada.' }, { status: 404 })

  const limit = checkRateLimit(`tool-test:${userId}`, { limit: 20, windowMs: 60_000 })
  if (!limit.success) return NextResponse.json({ error: 'Muitos testes seguidos. Aguarde um instante.' }, { status: 429 })

  const { data } = await supabaseAdmin().from('ai_tools').select('*').eq('id', id).eq('account_id', accountId).limit(1)
  const tool = ((data ?? []) as ToolRow[])[0]
  if (!tool) return NextResponse.json({ error: 'Não encontrada.' }, { status: 404 })

  const body = (await request.json().catch(() => null)) as { arguments?: unknown } | null
  const provided =
    body && typeof body.arguments === 'object' && body.arguments !== null && !Array.isArray(body.arguments)
      ? (body.arguments as Record<string, unknown>)
      : {}
  const args = { ...exampleArguments(tool.parameters), ...provided }

  const account = await loadAccountSecrets(accountId)
  const built = buildToolRequest(tool, args, account)
  if (built.missing.length > 0) {
    return NextResponse.json({
      ok: false,
      error: `Faltam variáveis/credenciais ou o host da chamada não é permitido para elas: ${built.missing.join(', ')}.`,
    })
  }

  try {
    const res = await safeFetch(
      built.url,
      { method: built.method, headers: { 'Content-Type': 'application/json', ...built.headers }, body: built.body },
      { timeoutMs: toolTimeoutMs(tool.timeout_ms), maxBytes: 1024 * 1024, failOnCrossOriginRedirect: built.credentialInjected },
    )
    const text = await res.text()
    return NextResponse.json({ ok: res.ok, status: res.status, body: sanitizeResponseBody(text, built.secretValues) })
  } catch (err) {
    // Mensagens genéricas: o erro real pode conter a URL resolvida.
    const message =
      err instanceof SsrfBlockedError
        ? err.reason === 'timeout'
          ? 'Tempo esgotado ao chamar a ferramenta.'
          : err.reason === 'cross_origin_redirect'
            ? 'O destino redirecionou para outro domínio; a chamada foi bloqueada para proteger a credencial.'
            : 'Destino não permitido.'
        : 'Não foi possível chamar a ferramenta.'
    return NextResponse.json({ ok: false, error: message })
  }
}
