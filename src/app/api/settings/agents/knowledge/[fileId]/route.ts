import { NextResponse } from 'next/server';
import { guardPermission } from '@/lib/auth/route-guard';
import { deleteKnowledgeFile } from '@/lib/ai/knowledge/files';

// DELETE /api/settings/agents/knowledge/[fileId] — ai.agents.edit. Recusa (409) se o arquivo é
// escolhido por alguma versão de agente, como as ferramentas.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(_request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await params;
  const auth = await guardPermission('ai.agents.edit');
  if (!auth.ok) return auth.response;
  if (!UUID.test(fileId)) return NextResponse.json({ error: 'Arquivo não encontrado.' }, { status: 404 });
  try {
    const result = await deleteKnowledgeFile(auth.ctx.accountId, fileId);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[settings/agents/knowledge] falha ao apagar:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Não foi possível remover o arquivo.' }, { status: 500 });
  }
}
