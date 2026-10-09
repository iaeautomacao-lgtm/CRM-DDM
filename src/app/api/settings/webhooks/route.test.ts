// /api/settings/webhooks/* — webhooks de saída pela sessão do painel (TASK2): permissão api_keys.manage, mesmo
// serviço da API v1 (validações, segredo uma vez), ids inválidos → 404 sem tocar no banco, ApiError repassado.

import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { can, type Permission } from '@/lib/auth/permissions';
import type { AccountRole } from '@/lib/auth/roles';
import { ApiError } from '@/lib/api/v1/respond';

const ACCOUNT = '00000000-0000-0000-0000-00000000000a';
const HOOK = '11111111-1111-4111-8111-111111111111';
const DELIVERY = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({ role: 'admin' as string }));
const svc = vi.hoisted(() => ({
  createEndpoint: vi.fn(),
  listEndpoints: vi.fn(),
  getEndpoint: vi.fn(),
  updateEndpoint: vi.fn(),
  deleteEndpoint: vi.fn(),
  rotateSecret: vi.fn(),
  listDeliveries: vi.fn(),
  replayDelivery: vi.fn(),
  enqueueTest: vi.fn(),
}));

vi.mock('@/lib/auth/route-guard', () => ({
  guardPermission: async (permission: Permission) =>
    can({ role: state.role as AccountRole }, permission)
      ? { ok: true, ctx: { accountId: ACCOUNT, userId: 'u', role: state.role } }
      : { ok: false, response: NextResponse.json({ error: 'Sem permissão.' }, { status: 403 }) },
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({ fake: true }) }));
vi.mock('@/lib/webhooks-out/endpoints', () => svc);
const audit = vi.hoisted(() => ({ logAuditEvent: vi.fn<(event: unknown) => Promise<void>>(async () => undefined) }));
vi.mock('@/lib/audit/log-event', () => audit);

const list = await import('./route');
const one = await import('./[id]/route');
const rotate = await import('./[id]/rotate-secret/route');
const test = await import('./[id]/test/route');
const deliveries = await import('./[id]/deliveries/route');
const replay = await import('./[id]/deliveries/[deliveryId]/replay/route');

const json = (body: unknown, method = 'POST') =>
  new Request('http://localhost/api/settings/webhooks', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

beforeEach(() => {
  state.role = 'admin';
  svc.listEndpoints.mockResolvedValue([{ id: HOOK, url: 'https://x.example/hook' }]);
  svc.createEndpoint.mockResolvedValue({ id: HOOK, url: 'https://x.example/hook', secret: 'whsec_123' });
  svc.updateEndpoint.mockResolvedValue({ id: HOOK, status: 'paused' });
  svc.rotateSecret.mockResolvedValue({ secret: 'whsec_novo' });
  svc.enqueueTest.mockResolvedValue({ delivery_id: DELIVERY });
  svc.listDeliveries.mockResolvedValue({ items: [], next_cursor: null });
  svc.replayDelivery.mockResolvedValue(undefined);
  svc.deleteEndpoint.mockResolvedValue(undefined);
  svc.getEndpoint.mockResolvedValue({ id: HOOK, url: 'https://x.example/hook' });
  audit.logAuditEvent.mockClear();
});

describe('/api/settings/webhooks', () => {
  it('admin lista endpoints com o catálogo de eventos', async () => {
    const res = await list.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.endpoints).toHaveLength(1);
    expect(body.events.map((e: { id: string }) => e.id)).toContain('message.received');
    expect(body.max_endpoints).toBe(10);
    expect(svc.listEndpoints).toHaveBeenCalledWith({ fake: true }, ACCOUNT);
  });

  it('cria pela sessão sem chave de origem e devolve o segredo uma vez', async () => {
    const res = await list.POST(json({ url: 'https://x.example/hook', events: ['message.received'], description: 'ERP' }));
    expect(res.status).toBe(201);
    expect((await res.json()).secret).toBe('whsec_123');
    expect(audit.logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'webhook.created', resourceId: HOOK, metadata: { host: 'x.example' } }),
    );
    expect(svc.createEndpoint).toHaveBeenCalledWith(
      { fake: true },
      { accountId: ACCOUNT, keyId: null, url: 'https://x.example/hook', events: ['message.received'], description: 'ERP' },
    );
  });

  it.each(['supervisor', 'agent', 'viewer'])('%s não acessa (api_keys.manage)', async (role) => {
    state.role = role;
    expect((await list.GET()).status).toBe(403);
    expect((await list.POST(json({}))).status).toBe(403);
    expect(svc.listEndpoints).not.toHaveBeenCalled();
  });

  it('erro de validação do serviço (ApiError) volta com o status e a mensagem', async () => {
    svc.createEndpoint.mockRejectedValueOnce(new ApiError('bad_request', '`url` deve usar https://', 400));
    const res = await list.POST(json({ url: 'http://x' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: '`url` deve usar https://', code: 'bad_request' });
  });

  it('falha inesperada → 500 genérico', async () => {
    svc.listEndpoints.mockRejectedValueOnce(new Error('db caiu'));
    const res = await list.GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Não foi possível concluir a operação.');
  });
});

describe('/api/settings/webhooks/[id]/*', () => {
  it('pausa, rotaciona (segredo uma vez), testa, lista entregas e reenvia', async () => {
    expect((await one.PATCH(json({ status: 'paused' }, 'PATCH'), p({ id: HOOK }))).status).toBe(200);
    expect(svc.updateEndpoint).toHaveBeenCalledWith({ fake: true }, ACCOUNT, HOOK, { status: 'paused' });

    const r = await rotate.POST(new Request('http://localhost'), p({ id: HOOK }));
    expect(await r.json()).toEqual({ secret: 'whsec_novo' });

    expect((await test.POST(new Request('http://localhost'), p({ id: HOOK }))).status).toBe(202);

    await deliveries.GET(new Request(`http://localhost/x?state=dead&limit=20&cursor=abc`), p({ id: HOOK }));
    expect(svc.listDeliveries).toHaveBeenCalledWith({ fake: true }, ACCOUNT, HOOK, { state: 'dead', cursor: 'abc', limit: 20 });

    expect((await replay.POST(new Request('http://localhost'), p({ id: HOOK, deliveryId: DELIVERY }))).status).toBe(202);
    expect(svc.replayDelivery).toHaveBeenCalledWith({ fake: true }, ACCOUNT, HOOK, DELIVERY);

    expect((await one.DELETE(new Request('http://localhost'), p({ id: HOOK }))).status).toBe(200);

    const actions = audit.logAuditEvent.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toEqual(['webhook.updated', 'webhook.secret_rotated', 'webhook.tested', 'webhook.delivery_replayed', 'webhook.deleted']);
    // Nunca o segredo na auditoria.
    expect(JSON.stringify(audit.logAuditEvent.mock.calls)).not.toContain('whsec_');
    expect(audit.logAuditEvent.mock.calls[0][0]).toMatchObject({ metadata: { fields: ['status'] } });
  });

  it('id inválido → 404 sem chamar o serviço', async () => {
    expect((await one.GET(new Request('http://localhost'), p({ id: 'x' }))).status).toBe(404);
    expect((await replay.POST(new Request('http://localhost'), p({ id: HOOK, deliveryId: 'x' }))).status).toBe(404);
    expect(svc.getEndpoint).not.toHaveBeenCalled();
    expect(svc.replayDelivery).not.toHaveBeenCalled();
  });

  it('reenvio de entrega que não está dead → 409 do serviço', async () => {
    svc.replayDelivery.mockRejectedValueOnce(new ApiError('conflict', "Só entregas com estado 'dead' deste webhook podem ser reenviadas", 409));
    const res = await replay.POST(new Request('http://localhost'), p({ id: HOOK, deliveryId: DELIVERY }));
    expect(res.status).toBe(409);
  });
});
