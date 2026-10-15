import { beforeEach, describe, expect, it, vi } from 'vitest';

// A2 — pause / resume / cancel / recipients/remove pela API pública. Operações de negócio e banco simulados; o que se prova aqui é o contrato
// HTTP: escopo, limite de 30/min, id inválido, corpo, envelope, auditoria só quando muda e sem dado pessoal.
const CAMP = '7c9e6679-0000-4000-8000-000000000020';
const hoisted = vi.hoisted(() => ({
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
  audits: [] as any[],
  scopes: [] as unknown[],
  state: { scopeError: null as Error | null, limited: false },
}));

vi.mock('@/lib/api/v1/log', () => ({ logPublicApiCall: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async (_r: Request, scope: unknown) => {
    hoisted.scopes.push(scope);
    if (hoisted.state.scopeError) throw hoisted.state.scopeError;
    return { accountId: 'ACC', keyId: 'KEY', createdBy: 'U', supabase: {} };
  }),
}));
vi.mock('@/lib/rate-limit', async (orig) => ({
  ...(await orig<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: vi.fn(async () => (hoisted.state.limited ? { success: false, remaining: 0, reset: Date.now() + 30_000, limit: 30 } : { success: true, remaining: 29, reset: 0, limit: 30 })),
}));
vi.mock('@/lib/disparador/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/audit/log-event', () => ({ logAuditEvent: vi.fn(async (a: unknown) => void hoisted.audits.push(a)) }));
vi.mock('@/lib/disparador/campaign-control', () => ({ pauseCampaign: hoisted.pause, resumeCampaign: hoisted.resume, cancelCampaign: hoisted.cancel }));
vi.mock('@/lib/api/v1/campaign-control-api', async (orig) => ({ ...(await orig<typeof import('@/lib/api/v1/campaign-control-api')>()), removeRecipients: hoisted.remove }));

import { ApiError } from '@/lib/api/v1/respond';
import { POST as pausePOST } from './[id]/pause/route';
import { POST as resumePOST } from './[id]/resume/route';
import { POST as cancelPOST } from './[id]/cancel/route';
import { POST as removePOST } from './[id]/recipients/remove/route';

const call = (handler: (r: Request, c: { params: Promise<{ id: string }> }) => Promise<Response>, id: string, body?: unknown) =>
  handler(new Request(`http://x/api/v1/disparador/campaigns/${id}/x`, { method: 'POST', headers: { authorization: 'Bearer k' }, body: body === undefined ? undefined : JSON.stringify(body) }), { params: Promise.resolve({ id }) });
const success = (over: Record<string, unknown> = {}) => ({ ok: true, changed: true, previous: 'em_execucao', status: 'pausada', itemsPendingMove: false, ...over });

beforeEach(() => {
  for (const f of [hoisted.pause, hoisted.resume, hoisted.cancel, hoisted.remove]) f.mockReset();
  hoisted.audits.length = 0;
  hoisted.scopes.length = 0;
  hoisted.state.scopeError = null;
  hoisted.state.limited = false;
});

describe.each([
  ['pause', pausePOST, hoisted.pause, {}],
  ['resume', resumePOST, hoisted.resume, {}],
  ['cancel', cancelPOST, hoisted.cancel, { confirm: true }],
  ['recipients/remove', removePOST, hoisted.remove, { recipients: [{ phone: '5521999998888' }] }],
] as const)('%s: contrato comum', (_name, handler, op, body) => {
  it('exige campaigns:write; sem escopo = 403 no envelope', async () => {
    op.mockResolvedValue(success());
    hoisted.remove.mockResolvedValue({ results: [], items_removed: 0, removed: 0, already_removed: 0, in_flight: 0, already_sent: 0, not_found: 0, invalid: 0 });
    await call(handler, CAMP, body);
    expect(hoisted.scopes[0]).toBe('campaigns:write');
    hoisted.state.scopeError = new ApiError('forbidden', 'Chave sem o escopo exigido', 403);
    const res = await call(handler, CAMP, body);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe('forbidden');
  });
  it('limite de 30/min por chave = 429 com Retry-After; id que não é UUID = 404', async () => {
    hoisted.state.limited = true;
    const limited = await call(handler, CAMP, body);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    hoisted.state.limited = false;
    const bad = await call(handler, 'nao-e-uuid', body);
    expect(bad.status).toBe(404);
    expect(op).not.toHaveBeenCalled();
  });
});

describe('pause', () => {
  it('200 com o resultado; audita só quando mudou; reason vai para a operação', async () => {
    hoisted.pause.mockResolvedValue(success({ itemsPendingMove: true }));
    const res = await call(pausePOST, CAMP, { reason: 'conferir' });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ campaign_id: CAMP, status: 'pausada', previous_status: 'em_execucao', changed: true, items_pending_move: true });
    expect(hoisted.pause).toHaveBeenCalledWith(expect.anything(), { accountId: 'ACC', campaignId: CAMP, reason: 'conferir' });
    expect(hoisted.audits).toHaveLength(1);
    expect(hoisted.audits[0]).toMatchObject({ action: 'campaign.paused', metadata: { origin: 'api', has_reason: true } });
    expect(JSON.stringify(hoisted.audits[0])).not.toContain('conferir');

    hoisted.audits.length = 0;
    hoisted.pause.mockResolvedValue(success({ changed: false, previous: 'pausada' }));
    const again = await call(pausePOST, CAMP);
    expect((await again.json()).data.changed).toBe(false);
    expect(hoisted.audits).toHaveLength(0);
  });
  it('conflito vira 409 com error.details.status; campanha de outra conta = 404; corpo inválido = 400', async () => {
    hoisted.pause.mockResolvedValue({ ok: false, kind: 'conflict', message: 'Só é possível pausar uma campanha em execução', details: { status: 'encerrada' } });
    const conflict = await call(pausePOST, CAMP);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toMatchObject({ code: 'conflict', details: { status: 'encerrada' } });
    hoisted.pause.mockResolvedValue({ ok: false, kind: 'not_found', message: 'Campanha não encontrada' });
    expect((await call(pausePOST, CAMP)).status).toBe(404);
    expect((await call(pausePOST, CAMP, { reason: 'x'.repeat(201) })).status).toBe(400);
  });
});

describe('resume', () => {
  it('passa acknowledge_auto_pause; bloqueios saem como 409 com details.code', async () => {
    hoisted.resume.mockResolvedValue(success({ previous: 'pausada', status: 'em_execucao' }));
    const res = await call(resumePOST, CAMP, { acknowledge_auto_pause: true });
    expect(res.status).toBe(200);
    expect(hoisted.resume).toHaveBeenCalledWith(expect.anything(), { accountId: 'ACC', campaignId: CAMP, acknowledgeAutoPause: true });
    expect(hoisted.audits[0]).toMatchObject({ action: 'campaign.resumed' });

    hoisted.resume.mockResolvedValue({ ok: false, kind: 'blocked', message: 'Número com qualidade vermelha', details: { code: 'red_quality', channels: [] } });
    const blocked = await call(resumePOST, CAMP);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.details.code).toBe('red_quality');
    expect((await call(resumePOST, CAMP, { acknowledge_auto_pause: 'sim' })).status).toBe(400);
  });
});

describe('cancel', () => {
  it('sem confirm = 400 e nada é cancelado; com confirm: motivo cancelled_api e auditoria', async () => {
    const without = await call(cancelPOST, CAMP, {});
    expect(without.status).toBe(400);
    expect(hoisted.cancel).not.toHaveBeenCalled();

    hoisted.cancel.mockResolvedValue(success({ previous: 'pausada', status: 'encerrada' }));
    const res = await call(cancelPOST, CAMP, { confirm: true });
    expect(res.status).toBe(200);
    expect(hoisted.cancel).toHaveBeenCalledWith(expect.anything(), { accountId: 'ACC', campaignId: CAMP, motive: 'cancelled_api' });
    expect(hoisted.audits[0]).toMatchObject({ action: 'campaign.cancelled', metadata: { previous_status: 'pausada' } });
  });
});

describe('recipients/remove', () => {
  const response = { results: [{ index: 0, status: 'removed', items: 1 }], items_removed: 1, removed: 1, already_removed: 0, in_flight: 0, already_sent: 0, not_found: 0, invalid: 0 };
  it('200 com o resultado por item; auditoria só com contagens, sem telefone/CPF/referência', async () => {
    hoisted.remove.mockResolvedValue(response);
    const res = await call(removePOST, CAMP, { reason: 'paid', recipients: [{ phone: '5521999998888' }, { cpf: '529.982.247-25' }, { reference: 'contrato-9' }] });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(response);
    const audit = JSON.stringify(hoisted.audits[0]);
    expect(audit).toContain('campaign.recipients_removed');
    expect(audit).not.toMatch(/5521999998888|529\.982|52998224725|contrato-9/);
  });
  it('nada removido = sem auditoria; campanha de outra conta (null) = 404; corpo inválido = 400', async () => {
    hoisted.remove.mockResolvedValue({ ...response, items_removed: 0, removed: 0, already_removed: 1 });
    await call(removePOST, CAMP, { recipients: [{ phone: '5521999998888' }] });
    expect(hoisted.audits).toHaveLength(0);
    hoisted.remove.mockResolvedValue(null);
    expect((await call(removePOST, CAMP, { recipients: [{ phone: '5521999998888' }] })).status).toBe(404);
    expect((await call(removePOST, CAMP, { recipients: [] })).status).toBe(400);
    expect((await call(removePOST, CAMP, { recipients: [{ phone: '5521999998888' }], reason: 'x' })).status).toBe(400);
  });
});
