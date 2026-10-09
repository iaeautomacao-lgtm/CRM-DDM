import { NextResponse } from 'next/server';
import { guardPermission } from '@/lib/auth/route-guard';
import { checkRateLimit } from '@/lib/rate-limit';
import { readKnowledgeFileContent } from '@/lib/ai/knowledge/files';
import { indexKnowledgeFile } from '@/lib/ai/knowledge/vector-store';
import { supabaseAdmin } from '@/lib/flows/admin-client';

// POST /api/settings/agents/knowledge/[fileId]/reindex — ai.agents.edit. (Re)gera o índice da busca por
// trechos (RAG vetorial, migration 215) de um arquivo da conta, com a chave de IA da conta. Serve para
// arquivos enviados antes da 215, para depois de cadastrar a chave e para tentar de novo após falha.
// Devolve a situação do índice (indexed/no_key/failed/too_large); nunca muda o texto do arquivo.

export const maxDuration = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  const auth = await guardPermission('ai.agents.edit');
  if (!auth.ok) return auth.response;
  const { accountId, userId } = auth.ctx;
  if (!UUID.test(fileId)) return NextResponse.json({ error: 'Arquivo não encontrado.' }, { status: 404 });

  const limit = await checkRateLimit(`kb-reindex:${userId}`, { limit: 10, windowMs: 60_000 });
  if (!limit.success) {
    return NextResponse.json({ error: 'Muitas reindexações seguidas. Aguarde um instante.' }, { status: 429 });
  }

  try {
    const file = await readKnowledgeFileContent(accountId, fileId);
    if (!file) return NextResponse.json({ error: 'Arquivo não encontrado.' }, { status: 404 });
    const result = await indexKnowledgeFile({ db: supabaseAdmin() }, accountId, file.id, file.content);
    return NextResponse.json({
      embedding_status: result.status,
      embedding_chunks: result.status === 'indexed' ? result.chunks : null,
    });
  } catch (err) {
    console.error('[settings/agents/knowledge] falha ao reindexar:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Não foi possível reindexar o arquivo.' }, { status: 500 });
  }
}
