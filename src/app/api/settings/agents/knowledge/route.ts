import { NextResponse } from 'next/server';
import { guardPermission } from '@/lib/auth/route-guard';
import { checkRateLimit } from '@/lib/rate-limit';
import { extractKnowledgeText } from '@/lib/ai/knowledge/extract';
import { createKnowledgeFile, listKnowledgeFiles } from '@/lib/ai/knowledge/files';
import {
  KB_MAX_FILE_BYTES,
  KB_MAX_NAME_CHARS,
  knowledgeFileKind,
  knowledgeMimeType,
} from '@/lib/ai/knowledge/limits';

// /api/settings/agents/knowledge — arquivos de conhecimento da conta (migration 214).
//
//   GET  ai.agents.view : lista (nome, tamanho, caracteres; o texto nunca volta).
//   POST ai.agents.edit : multipart com `file` (PDF, DOCX, TXT/MD, CSV; até 10 MB). O texto é
//                         extraído NO SERVIDOR (extract.ts, worker com tempo e memória limitados)
//                         e guardado; devolve { file } com o id. O arquivo original não é guardado.

export async function GET() {
  const auth = await guardPermission('ai.agents.view');
  if (!auth.ok) return auth.response;
  try {
    return NextResponse.json({ files: await listKnowledgeFiles(auth.ctx.accountId) });
  } catch (err) {
    console.error('[settings/agents/knowledge] falha ao listar:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Não foi possível carregar os arquivos.' }, { status: 500 });
  }
}

// Folga do multipart (boundary, cabeçalhos da parte) sobre o teto do arquivo.
const MULTIPART_OVERHEAD = 64 * 1024;

export async function POST(request: Request) {
  const auth = await guardPermission('ai.agents.edit');
  if (!auth.ok) return auth.response;
  const { accountId, userId } = auth.ctx;

  const limit = await checkRateLimit(`kb-upload:${userId}`, { limit: 10, windowMs: 60_000 });
  if (!limit.success) {
    return NextResponse.json({ error: 'Muitos envios seguidos. Aguarde um instante.' }, { status: 429 });
  }

  // Recusa cedo pelo Content-Length, antes de ler o corpo.
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > KB_MAX_FILE_BYTES + MULTIPART_OVERHEAD) {
    return NextResponse.json({ error: 'Arquivo maior que 10 MB.' }, { status: 413 });
  }

  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: 'Envie o arquivo no campo "file".' }, { status: 400 });
  }
  if (file.size > KB_MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'Arquivo maior que 10 MB.' }, { status: 413 });
  }

  const name = file.name.trim().slice(0, KB_MAX_NAME_CHARS) || 'arquivo';
  const kind = knowledgeFileKind(name);
  const extracted = await extractKnowledgeText(kind, new Uint8Array(await file.arrayBuffer()));
  if (!extracted.ok) {
    const status = extracted.code === 'busy' ? 429 : extracted.code === 'too_large' ? 413 : 422;
    return NextResponse.json({ error: extracted.message, code: extracted.code }, { status });
  }

  try {
    const saved = await createKnowledgeFile({
      accountId,
      userId,
      name,
      mimeType: knowledgeMimeType(name, kind!),
      sizeBytes: file.size,
      text: extracted.text,
    });
    return NextResponse.json({ file: saved, pages: extracted.pages ?? null }, { status: 201 });
  } catch (err) {
    console.error('[settings/agents/knowledge] falha ao salvar:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Não foi possível salvar o arquivo.' }, { status: 500 });
  }
}
