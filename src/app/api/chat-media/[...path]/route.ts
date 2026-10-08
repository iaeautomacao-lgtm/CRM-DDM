import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { chatMediaReference } from '@/lib/storage/chat-media';
import { NextResponse } from 'next/server';

// GET /api/chat-media/<account-uuid>/<...arquivo>
//
// Ponto de acesso do navegador aos anexos do bucket privado `chat-media`.
// Caminho atual: account-<account_id>/...
//
// Compatibilidade V1:
// por um período, o webhook Meta gravou inbound em meta/<mediaId>.<ext>,
// sem o prefixo da conta. Para esses objetos legados, só geramos a URL
// assinada depois de provar pelo banco que a mensagem pertence à conta
// do usuário logado.
export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  try {
    const { accountId, supabase } = await getCurrentAccount();
    const { path: segments } = await context.params;

    if (
      segments.length === 0 ||
      segments.some(
        (part) =>
          !part ||
          part === '..' ||
          part === '.' ||
          part.includes('/') ||
          part.includes('\\'),
      )
    ) {
      return NextResponse.json({ error: 'Anexo não encontrado' }, { status: 404 });
    }

    const path = segments.join('/');

    // Formato atual: a própria pasta já carrega o account_id e a RLS do
    // Storage funciona como segunda barreira.
    if (segments[0] === `account-${accountId}`) {
      const { data, error } = await supabase.storage
        .from('chat-media')
        .createSignedUrl(path, 60);

      if (error || !data?.signedUrl) {
        return NextResponse.json({ error: 'Anexo indisponível' }, { status: 404 });
      }

      const response = NextResponse.redirect(data.signedUrl);
      response.headers.set('Cache-Control', 'private, no-store');
      return response;
    }

    // Compatibilidade estritamente limitada ao bug antigo da Meta.
    // Não aceitamos outros caminhos sem account_id.
    if (segments[0] !== 'meta' || segments.length !== 2) {
      return NextResponse.json({ error: 'Anexo não encontrado' }, { status: 404 });
    }

    const stableRef = chatMediaReference(path);
    const rawRef = path;

    // messages não tem account_id; o join com conversations faz o vínculo
    // de tenancy antes de usar service role para assinar o objeto legado.
    const db = supabaseAdmin();
    const { data: ownedRows, error: ownedError } = await db
      .from('messages')
      .select('id, conversations!inner(account_id)')
      .in('media_url', [stableRef, rawRef])
      .eq('conversations.account_id', accountId)
      .limit(1);

    if (ownedError || !ownedRows || ownedRows.length === 0) {
      return NextResponse.json({ error: 'Anexo não encontrado' }, { status: 404 });
    }

    const { data, error } = await db.storage
      .from('chat-media')
      .createSignedUrl(path, 60);

    if (error || !data?.signedUrl) {
      return NextResponse.json({ error: 'Anexo indisponível' }, { status: 404 });
    }

    const response = NextResponse.redirect(data.signedUrl);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return toErrorResponse(error);
  }
}
