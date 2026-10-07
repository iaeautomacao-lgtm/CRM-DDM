import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: mocks.admin }));
vi.mock('@/lib/audit/context', () => ({ registerAuditActor: vi.fn() }));
import { POST } from './route';
import { wahaChannelWebhookSecret } from '@/lib/whatsapp/waha-webhook-auth';

const CHANNEL = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const URL_BASE = 'https://crm.test/api/whatsapp/webhook/waha';

type Call = { table: string; method: string; args: unknown[] };

// Builder encadeável do supabase-js: grava as chamadas e resolve com
// as linhas de whatsapp_config informadas.
function fakeDb(configRows: Record<string, unknown>[]) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const result = table === 'whatsapp_config'
      ? { data: configRows, error: null }
      : { data: null, error: null };
    const builder: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => resolve(result),
    };
    for (const method of ['select', 'eq', 'in', 'limit', 'update', 'maybeSingle']) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return builder;
      };
    }
    return builder;
  };
  mocks.admin.mockReturnValue({ from });
  return calls;
}

function ackRequest(url: string, secret: string | null, session = 'sessao-a') {
  return new Request(url, {
    method: 'POST',
    headers: secret ? { 'x-webhook-secret': secret } : {},
    body: JSON.stringify({ event: 'message.ack', session, payload: { id: 'm1', ack: 2 } }),
  });
}

describe('WAHA webhook authentication', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  it('does not accept an unsigned payload when configuration is absent', async () => {
    vi.stubEnv('WAHA_WEBHOOK_SECRET', '');
    const response = await POST(
      new Request(URL_BASE, {
        method: 'POST',
        body: '{}',
      })
    );
    expect(response.status).toBe(503);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it('rejects an incorrect secret before parsing untrusted input or creating an admin client', async () => {
    vi.stubEnv('WAHA_WEBHOOK_SECRET', 'test-secret');
    const response = await POST(
      new Request(`${URL_BASE}?channel=${CHANNEL}`, {
        method: 'POST',
        headers: { 'x-webhook-secret': 'wrong' },
        body: 'not-json',
      })
    );
    expect(response.status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('rejeita o segredo de outro canal e o segredo global com ?channel=', async () => {
    vi.stubEnv('WAHA_WEBHOOK_SECRET', 'test-secret');
    vi.stubEnv('WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET', 'true');
    for (const secret of [wahaChannelWebhookSecret(OTHER), 'test-secret']) {
      const response = await POST(ackRequest(`${URL_BASE}?channel=${CHANNEL}`, secret));
      expect(response.status).toBe(401);
    }
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it('aceita o segredo do canal e resolve a config por id + sessão', async () => {
    vi.stubEnv('WAHA_WEBHOOK_SECRET', 'test-secret');
    const calls = fakeDb([{ id: CHANNEL, account_id: 'conta-a', waha_session: 'sessao-a' }]);
    const response = await POST(
      ackRequest(`${URL_BASE}?channel=${CHANNEL}`, wahaChannelWebhookSecret(CHANNEL))
    );
    expect(response.status).toBe(200);
    const configEqs = calls
      .filter((c) => c.table === 'whatsapp_config' && c.method === 'eq')
      .map((c) => c.args);
    expect(configEqs).toEqual(
      expect.arrayContaining([['id', CHANNEL], ['waha_session', 'sessao-a'], ['provider', 'waha']])
    );
    // Status escopado pela conta do canal autenticado.
    expect(calls).toContainEqual({ table: 'messages', method: 'eq', args: ['account_id', 'conta-a'] });
  });

  it('sessão do corpo que não pertence ao canal não encontra config (404)', async () => {
    vi.stubEnv('WAHA_WEBHOOK_SECRET', 'test-secret');
    fakeDb([]);
    const response = await POST(
      ackRequest(`${URL_BASE}?channel=${CHANNEL}`, wahaChannelWebhookSecret(CHANNEL), 'sessao-b')
    );
    expect(response.status).toBe(404);
  });

  it('segredo global sem ?channel= só passa com a flag de transição', async () => {
    vi.stubEnv('WAHA_WEBHOOK_SECRET', 'test-secret');
    expect((await POST(ackRequest(URL_BASE, 'test-secret'))).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();

    vi.stubEnv('WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET', 'true');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = fakeDb([{ id: CHANNEL, account_id: 'conta-a', waha_session: 'sessao-a' }]);
    expect((await POST(ackRequest(URL_BASE, 'test-secret'))).status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('legado'));
    expect(calls.some((c) => c.method === 'eq' && c.args[0] === 'id')).toBe(false);
    warn.mockRestore();
  });

  it('legado: sessão ambígua (mais de uma config) é recusada', async () => {
    vi.stubEnv('WAHA_WEBHOOK_SECRET', 'test-secret');
    vi.stubEnv('WAHA_WEBHOOK_ACCEPT_LEGACY_SECRET', 'true');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fakeDb([
      { id: CHANNEL, account_id: 'conta-a', waha_session: 'sessao-a' },
      { id: OTHER, account_id: 'conta-b', waha_session: 'sessao-a' },
    ]);
    expect((await POST(ackRequest(URL_BASE, 'test-secret'))).status).toBe(404);
  });
});
