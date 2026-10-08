import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { can } from '@/lib/auth/permissions';
import { NextResponse } from 'next/server';

// /api/calls/* — proxy autenticado do navegador para o servidor VoIP (Go).
//
// O navegador não fala mais direto com o VoIP. Aqui validamos a sessão do
// CRM e repassamos a identidade para o Go em headers internos:
//   Authorization: Bearer VOIP_SERVICE_SECRET  (prova que veio do Next)
//   X-Voip-Account / X-Voip-Role               (conta e papel do usuário)
// O Go (voip/cmd/server/security.go) confia nesses headers só quando o
// segredo confere e filtra sessões/eventos pela conta.
async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const ctx = await getCurrentAccount();
    const { accountId, role } = ctx;
    // VoIP: calls.use (todos menos o visualizador, como antes)
    if (!can(ctx, 'calls.use')) return NextResponse.json({ error: 'Sem permissão para chamadas' }, { status: 403 });
    const secret = process.env.VOIP_SERVICE_SECRET;
    if (!secret || !process.env.VOIP_URL) return NextResponse.json({ error: 'VoIP indisponível' }, { status: 503 });
    let { path } = await context.params;
    // Aceita tanto /api/calls/sessions/... quanto /api/calls/api/sessions/...
    if (path[0] === 'api') path = path.slice(1);
    // Allowlist de rotas do VoIP + bloqueio de traversal: o proxy não pode
    // ser usado para alcançar outros endpoints internos do servidor Go.
    if (!['sessions', 'events'].includes(path[0]) || path.some(part => !part || part === '.' || part === '..' || /[\\/]/.test(part)))
      return NextResponse.json({ error: 'Rota inválida' }, { status: 404 });
    const url = new URL('/api/' + path.map(encodeURIComponent).join('/'), process.env.VOIP_URL);
    url.search = new URL(request.url).search;
    const headers = new Headers({ Authorization: `Bearer ${secret}`, 'X-Voip-Account': accountId, 'X-Voip-Role': role, 'X-Client-Id': request.headers.get('x-client-id') ?? '' });
    if (request.headers.get('content-type')) headers.set('Content-Type', request.headers.get('content-type')!);
    // Timeout de 55s (abaixo do limite do proxy reverso) e redirect proibido,
    // para o segredo interno nunca ser reenviado a outro host.
    const response = await fetch(url, { method: request.method, headers, body: ['GET','HEAD'].includes(request.method) ? undefined : await request.text(), signal: AbortSignal.any([request.signal, AbortSignal.timeout(55_000)]), redirect: 'error' });
    // Repassa o corpo como stream (necessário para o SSE de /events);
    // X-Accel-Buffering: no desliga o buffer do nginx para o SSE fluir.
    return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no' } });
  } catch (error) { return toErrorResponse(error); }
}
export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
