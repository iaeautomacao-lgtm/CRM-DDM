import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { NextResponse } from 'next/server';
async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { accountId, role } = await getCurrentAccount();
    if (role === 'viewer') return NextResponse.json({ error: 'Sem permissão para chamadas' }, { status: 403 });
    const secret = process.env.VOIP_SERVICE_SECRET;
    if (!secret || !process.env.VOIP_URL) return NextResponse.json({ error: 'VoIP indisponível' }, { status: 503 });
    let { path } = await context.params;
    if (path[0] === 'api') path = path.slice(1);
    if (!['sessions', 'events'].includes(path[0]) || path.some(part => !part || part === '.' || part === '..' || /[\\/]/.test(part)))
      return NextResponse.json({ error: 'Rota inválida' }, { status: 404 });
    const url = new URL('/api/' + path.map(encodeURIComponent).join('/'), process.env.VOIP_URL);
    url.search = new URL(request.url).search;
    const headers = new Headers({ Authorization: `Bearer ${secret}`, 'X-Voip-Account': accountId, 'X-Voip-Role': role, 'X-Client-Id': request.headers.get('x-client-id') ?? '' });
    if (request.headers.get('content-type')) headers.set('Content-Type', request.headers.get('content-type')!);
    const response = await fetch(url, { method: request.method, headers, body: ['GET','HEAD'].includes(request.method) ? undefined : await request.text(), signal: AbortSignal.any([request.signal, AbortSignal.timeout(55_000)]), redirect: 'error' });
    return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no' } });
  } catch (error) { return toErrorResponse(error); }
}
export const GET = proxy;
export const POST = proxy;
export const DELETE = proxy;
