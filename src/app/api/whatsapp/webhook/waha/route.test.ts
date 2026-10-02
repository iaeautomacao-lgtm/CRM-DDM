import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ admin: vi.fn() }));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: mocks.admin }));
import { POST } from './route';

describe('WAHA webhook authentication', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  it('does not accept an unsigned payload when configuration is absent', async () => {
    vi.stubEnv('WAHA_WEBHOOK_SECRET', '');
    const response = await POST(
      new Request('https://crm.test/api/whatsapp/webhook/waha', {
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
      new Request('https://crm.test/api/whatsapp/webhook/waha', {
        method: 'POST',
        headers: { 'x-webhook-secret': 'wrong' },
        body: 'not-json',
      })
    );
    expect(response.status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});
