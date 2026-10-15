import { describe, expect, it, vi } from 'vitest';

import { loadLiveWorkerSessions } from './worker-ownership';

const rpc = (result: { data?: unknown; error?: { code?: string; message: string } | null }) => ({ rpc: async () => ({ data: result.data ?? null, error: result.error ?? null }) }) as never;

describe('loadLiveWorkerSessions (o cron só pula número com worker vivo)', () => {
  it('devolve o conjunto de números com dono vivo', async () => {
    expect([...(await loadLiveWorkerSessions(rpc({ data: ['S1', 'S2'] })))].sort()).toEqual(['S1', 'S2']);
  });
  it('sem migration 367 (função ausente): vazio, sem ruído — o cron envia tudo', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await loadLiveWorkerSessions(rpc({ error: { code: '42883', message: 'function does not exist' } }))).size).toBe(0);
    expect((await loadLiveWorkerSessions(rpc({ error: { code: 'PGRST202', message: 'not found' } }))).size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });
  it('erro de leitura ou resposta inesperada: vazio (o cron cobre) e nunca lança', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await loadLiveWorkerSessions(rpc({ error: { code: 'XX', message: 'boom' } }))).size).toBe(0);
    expect((await loadLiveWorkerSessions(rpc({ data: 'lixo' }))).size).toBe(0);
    expect((await loadLiveWorkerSessions({ rpc: async () => { throw new Error('rede'); } } as never)).size).toBe(0);
  });
});
