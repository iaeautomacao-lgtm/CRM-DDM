import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { NextResponse } from 'next/server';

// GET /api/chat-media/<account-uuid>/<...arquivo>
//
// Ponto de acesso do navegador aos anexos do bucket privado `chat-media`
// (migration 121). As mensagens guardam esta referência estável; a cada
// acesso validamos a sessão e redirecionamos para uma URL assinada de 60s.
export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { accountId, supabase } = await getCurrentAccount();
    const { path: segments } = await context.params;
    // Bloqueia path traversal e exige que o primeiro segmento seja a pasta
    // da conta do usuário logado. 404 (e não 403) para não confirmar a
    // existência de arquivos de outras contas.
    if (segments.some(part => !part || part === '..' || part === '.' || part.includes('/') || part.includes('\\')) || segments[0] !== `account-${accountId}`)
      return NextResponse.json({ error: 'Anexo não encontrado' }, { status: 404 });
    // Cliente com a sessão do usuário (não service role): a policy de
    // leitura do Storage é aplicada também, como segunda barreira.
    const { data, error } = await supabase.storage.from('chat-media').createSignedUrl(segments.join('/'), 60);
    if (error || !data) return NextResponse.json({ error: 'Anexo indisponível' }, { status: 404 });
    const response = NextResponse.redirect(data.signedUrl);
    // Não deixa proxy/navegador cachear o redirect com a URL assinada.
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) { return toErrorResponse(error); }
}
