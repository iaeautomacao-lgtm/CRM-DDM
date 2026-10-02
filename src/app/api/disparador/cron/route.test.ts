import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  process: vi.fn(),
  start: vi.fn(),
  callback: vi.fn(),
}));
vi.mock('@/lib/disparador/admin-client', () => ({
  supabaseAdmin: () => ({ from: mocks.from, rpc: mocks.rpc }),
}));
vi.mock('@/lib/disparador/processQueue', () => ({
  processQueueItem: mocks.process,
  checkWithinWindow: () => true,
  sendCampaignCallback: mocks.callback,
}));
vi.mock('@/lib/disparador/startCampaign', () => ({
  startCampaign: mocks.start,
}));
import { GET, POST } from './route';

describe('dispatch cron authentication and diagnostics', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });
  it('fails closed when not configured, without touching the queue', async () => {
    vi.stubEnv('CRON_SECRET', '');
    expect(
      (
        await POST(
          new Request('https://crm.test/api/disparador/cron', {
            method: 'POST',
          })
        )
      ).status
    ).toBe(503);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('rejects an invalid credential before any database operation', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret');
    expect(
      (
        await POST(
          new Request('https://crm.test/api/disparador/cron', {
            method: 'POST',
            headers: { 'x-cron-secret': 'wrong' },
          })
        )
      ).status
    ).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });
  it('GET is read-only and cannot start, retry, claim, complete or send', async () => {
    vi.stubEnv('CRON_SECRET', 'test-secret');
    const limit = vi.fn(async () => ({ error: null }));
    mocks.from.mockReturnValue({ select: () => ({ limit }) });
    const response = await GET(
      new Request('https://crm.test/api/disparador/cron', {
        headers: { 'x-cron-secret': 'test-secret' },
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.from).toHaveBeenCalledWith('campaigns');
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.process).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.callback).not.toHaveBeenCalled();
  });
});
