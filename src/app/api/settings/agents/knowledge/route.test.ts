// Rotas de arquivos de conhecimento (TASK1-B): permissão do catálogo, teto de tamanho, extração no
// servidor (texto real; PDF/DOCX ficam no teste do extract) e recusa de remoção de arquivo em uso.

import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { can, type Permission } from '@/lib/auth/permissions';
import type { AccountRole } from '@/lib/auth/roles';

const ACCOUNT = '00000000-0000-0000-0000-00000000000a';
const USER = '00000000-0000-0000-0000-000000000001';
const FILE_ID = '00000000-0000-0000-0000-000000000004';

const state = vi.hoisted(() => ({ role: 'admin' as string }));
const files = vi.hoisted(() => ({
  listKnowledgeFiles: vi.fn(),
  createKnowledgeFile: vi.fn(),
  deleteKnowledgeFile: vi.fn(),
}));

vi.mock('@/lib/auth/route-guard', () => ({
  guardPermission: async (permission: Permission) =>
    can({ role: state.role as AccountRole }, permission)
      ? { ok: true, ctx: { accountId: ACCOUNT, userId: USER, role: state.role } }
      : { ok: false, response: NextResponse.json({ error: 'Sem permissão.' }, { status: 403 }) },
}));
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: async () => ({ success: true }) }));
vi.mock('@/lib/ai/knowledge/files', () => files);

const { GET, POST } = await import('./route');
const { DELETE } = await import('./[fileId]/route');

function upload(name: string, content: string | Uint8Array, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', new File([content], name));
  return new Request('http://localhost/api/settings/agents/knowledge', { method: 'POST', body: form, headers });
}

beforeEach(() => {
  state.role = 'admin';
  files.listKnowledgeFiles.mockResolvedValue([]);
  files.createKnowledgeFile.mockImplementation(async (input: { name: string; text: string; sizeBytes: number; mimeType: string }) => ({
    id: FILE_ID,
    name: input.name,
    mime_type: input.mimeType,
    size_bytes: input.sizeBytes,
    char_count: input.text.length,
    created_at: '2026-10-09T12:00:00Z',
  }));
  files.deleteKnowledgeFile.mockResolvedValue({ ok: true });
});

describe('GET /api/settings/agents/knowledge', () => {
  it('supervisor lista (ai.agents.view); operador não', async () => {
    state.role = 'supervisor';
    files.listKnowledgeFiles.mockResolvedValue([{ id: FILE_ID, name: 'a.txt' }]);
    const ok = await GET();
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ files: [{ id: FILE_ID, name: 'a.txt' }] });
    expect(files.listKnowledgeFiles).toHaveBeenCalledWith(ACCOUNT);

    state.role = 'agent';
    expect((await GET()).status).toBe(403);
  });
});

describe('POST /api/settings/agents/knowledge', () => {
  it('admin envia CSV: texto extraído no servidor e guardado na conta, devolve o id', async () => {
    const res = await POST(upload('tabela.csv', 'nome;valor\r\nA;1\r\n'));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.file).toMatchObject({ id: FILE_ID, name: 'tabela.csv', mime_type: 'text/csv', char_count: 14 });
    expect(files.createKnowledgeFile).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: ACCOUNT, userId: USER, name: 'tabela.csv', text: 'nome;valor\nA;1', sizeBytes: 17 }),
    );
  });

  it('supervisor não envia (ai.agents.edit)', async () => {
    state.role = 'supervisor';
    expect((await POST(upload('a.txt', 'x'))).status).toBe(403);
    expect(files.createKnowledgeFile).not.toHaveBeenCalled();
  });

  it('formato não aceito e arquivo vazio voltam 422 com mensagem legível', async () => {
    const xlsx = await POST(upload('planilha.xlsx', 'x'));
    expect(xlsx.status).toBe(422);
    expect((await xlsx.json()).error).toMatch(/Formato não aceito/);
    const empty = await POST(upload('vazio.txt', '   '));
    expect(empty.status).toBe(422);
    expect((await empty.json()).code).toBe('empty');
    expect(files.createKnowledgeFile).not.toHaveBeenCalled();
  });

  it('Content-Length acima de 10 MB é recusado com 413 antes de ler o corpo', async () => {
    const res = await POST(upload('a.txt', 'x', { 'content-length': String(11 * 1024 * 1024) }));
    expect(res.status).toBe(413);
  });

  it('sem o campo file → 400', async () => {
    const res = await POST(new Request('http://localhost/api/settings/agents/knowledge', { method: 'POST', body: new FormData() }));
    expect(res.status).toBe(400);
  });

  it('falha ao gravar → 500 genérico', async () => {
    files.createKnowledgeFile.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(upload('a.txt', 'conteúdo'));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Não foi possível salvar o arquivo.');
  });
});

describe('DELETE /api/settings/agents/knowledge/[fileId]', () => {
  const del = (id: string) => DELETE(new Request('http://localhost'), { params: Promise.resolve({ fileId: id }) });

  it('admin remove o arquivo da própria conta', async () => {
    const res = await del(FILE_ID);
    expect(res.status).toBe(200);
    expect(files.deleteKnowledgeFile).toHaveBeenCalledWith(ACCOUNT, FILE_ID);
  });

  it('arquivo em uso por agente → 409 com a mensagem do serviço', async () => {
    files.deleteKnowledgeFile.mockResolvedValueOnce({ ok: false, status: 409, error: 'Este arquivo é usado por agentes.' });
    const res = await del(FILE_ID);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('Este arquivo é usado por agentes.');
  });

  it('id inválido → 404; supervisor → 403', async () => {
    expect((await del('nao-e-uuid')).status).toBe(404);
    state.role = 'supervisor';
    expect((await del(FILE_ID)).status).toBe(403);
    expect(files.deleteKnowledgeFile).not.toHaveBeenCalled();
  });
});
