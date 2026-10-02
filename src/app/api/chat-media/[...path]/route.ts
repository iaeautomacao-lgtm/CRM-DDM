import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { NextResponse } from 'next/server';
export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { accountId, supabase } = await getCurrentAccount();
    const { path: segments } = await context.params;
    if (segments.some(part => !part || part === '..' || part === '.' || part.includes('/') || part.includes('\\')) || segments[0] !== `account-${accountId}`)
      return NextResponse.json({ error: 'Anexo não encontrado' }, { status: 404 });
    // User-scoped storage client also enforces the storage read policy.
    const { data, error } = await supabase.storage.from('chat-media').createSignedUrl(segments.join('/'), 60);
    if (error || !data) return NextResponse.json({ error: 'Anexo indisponível' }, { status: 404 });
    const response = NextResponse.redirect(data.signedUrl);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) { return toErrorResponse(error); }
}
