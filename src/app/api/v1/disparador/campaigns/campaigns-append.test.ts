import { beforeEach, describe, expect, it, vi } from 'vitest';

// A3 — POST /disparador/campaigns/{id}/recipients: contrato HTTP (escopo, Idempotency-Key obrigatória, limite, corpo, envelope, auditoria).
const CAMP = '7c9e6679-0000-4000-8000-000000000020';
const hoisted = vi.hoisted(() => ({
  append: vi.fn(),
  ledger: vi.fn(),
  audits: [] as any[],
  state: { scopeError: null as Error | null, limited: false },
}));

vi.mock('@/lib/api/v1/log', () => ({ logPublicApiCall: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => {
    if (hoisted.state.scopeError) throw hoisted.state.scopeError;
    return { accountId: 'ACC', keyId: 'KEY', createdBy: 'U', supabase: {} };
  }),
}));
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: vi.fn(async () => (hoisted.state.limited ? { success: false, remaining: 0, reset: Date.now() + 30_000, limit: 6 } : { success: true, remaining: 5, reset: 0, limit: 6 })),
}));
vi.mock('@/lib/disparador/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/audit/log-event', () => ({ logAuditEvent: vi.fn(async (a: unknown) => void hoisted.audits.push(a)) }));
vi.mock('@/lib/api/v1/campaign-append', () => ({ appendRecipients: hoisted.append }));
// O ledger real exige Idempotency-Key e fala com o banco: aqui só se confere que a rota o usa e passa apiEnvelope.
vi.mock('@/lib/disparador/send-ledger', () => ({
  runIdempotentSend: async (accountId: string, request: Request, work: (c: unknown) => Promise<Response>, options: unknown) => {
    hoisted.ledger(accountId, options);
    const key = request.headers.get('idempotency-key');
    if (!key || key.length < 8) {
      const { ApiError } = await import('@/lib/api/v1/respond');
      throw new ApiError('bad_request', 'Informe uma chave Idempotency-Key por intenção de envio', 400);
    }
    return work({ providerCalled: () => {} });
  },
}));
vi.mock('@/lib/api/v1/extract', async (orig) => orig());

import { ApiError } from '@/lib/api/v1/respond';
import { POST } from './[id]/recipients/route';

const call = (id: string, body: unknown, headers: Record<string, string> = { 'idempotency-key': 'append-0001-aaaa' }, raw?: string) =>
  POST(new Request(`http://x/api/v1/disparador/campaigns/${id}/recipients`, { method: 'POST', headers: { authorization: 'Bearer k', ...headers }, body: raw ?? JSON.stringify(body) }), { params: Promise.resolve({ id }) });

const result = { added: 2, duplicates: 0, skipped: 0, invalid: 0, invalid_sample: [], total_contacts: 12, estimated_completion_minutes: 0 };

beforeEach(() => {
  hoisted.append.mockReset();
  hoisted.append.mockResolvedValue(result);
  hoisted.ledger.mockReset();
  hoisted.audits.length = 0;
  hoisted.state.scopeError = null;
  hoisted.state.limited = false;
});

describe('POST /disparador/campaigns/{id}/recipients', () => {
  it('200 com o resultado; usa o ledger de idempotência em modo envelope; audita só contagens', async () => {
    const res = await call(CAMP, { contacts: [{ phone: '5521999998888', variables: ['Ana'], reference: 'seg-contrato-7' }] });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(result);
    expect(hoisted.ledger).toHaveBeenCalledWith('ACC', { apiEnvelope: true });
    expect(hoisted.append).toHaveBeenCalledWith(expect.anything(), { accountId: 'ACC', campaignId: CAMP, contacts: [{ phone: '5521999998888', variables: ['Ana'], reference: 'seg-contrato-7' }] });
    const audit = JSON.stringify(hoisted.audits[0]);
    expect(audit).toContain('campaign.recipients_added');
    expect(audit).not.toMatch(/5521999998888|seg-contrato-7|Ana/);
  });

  it('sem Idempotency-Key = 400 e nada é adicionado', async () => {
    const res = await call(CAMP, { contacts: [] }, {});
    expect(res.status).toBe(400);
    expect(hoisted.append).not.toHaveBeenCalled();
  });

  it('sem escopo = 403; id inválido = 404; limite de 6/min = 429 com Retry-After', async () => {
    hoisted.state.scopeError = new ApiError('forbidden', 'Chave sem o escopo exigido', 403);
    expect((await call(CAMP, { contacts: [{}] })).status).toBe(403);
    hoisted.state.scopeError = null;
    expect((await call('nao-uuid', { contacts: [{}] })).status).toBe(404);
    hoisted.state.limited = true;
    const limited = await call(CAMP, { contacts: [{}] });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect(hoisted.append).not.toHaveBeenCalled();
  });

  it('corpo inválido (JSON ruim, não-objeto, sem lista) = 400', async () => {
    expect((await call(CAMP, null, undefined, '{x')).status).toBe(400);
    expect((await call(CAMP, [1])).status).toBe(400);
    expect((await call(CAMP, { contacts: 'x' })).status).toBe(400);
    expect(hoisted.append).not.toHaveBeenCalled();
  });

  it('erros de negócio da lib saem no envelope (409 com details; 413 no teto)', async () => {
    hoisted.append.mockRejectedValue(new ApiError('conflict', 'Só é possível adicionar contatos a uma campanha em execução ou pausada', 409, undefined, undefined, { details: { status: 'encerrada' } }));
    const conflict = await call(CAMP, { contacts: [{ phone: '1' }] });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toMatchObject({ code: 'conflict', details: { status: 'encerrada' } });
    hoisted.append.mockRejectedValue(new ApiError('payload_too_large', 'acima de 50000', 413));
    expect((await call(CAMP, { contacts: [{ phone: '1' }] })).status).toBe(413);
    expect(hoisted.audits).toHaveLength(0);
  });

  it('nada adicionado = sem auditoria', async () => {
    hoisted.append.mockResolvedValue({ ...result, added: 0, duplicates: 2 });
    await call(CAMP, { contacts: [{ phone: '5521999998888', variables: ['Ana'] }] });
    expect(hoisted.audits).toHaveLength(0);
  });
});
