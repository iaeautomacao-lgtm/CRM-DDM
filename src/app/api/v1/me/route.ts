// ============================================================
// GET /api/v1/me — public API identity probe.
//
// The reference endpoint for the public API: it requires nothing
// but a valid key (no scope), and returns the account the key is
// bound to plus the scopes it carries. Integrators use it to verify
// their key works and to discover what it's allowed to do before
// wiring up real calls.
//
// It also exercises the entire public-API stack end to end — bearer
// parse → hash lookup → liveness → rate limit → envelope — so a
// green response here means the plumbing every future endpoint
// depends on is sound.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { getAccountName } from '@/lib/api-keys/store';
import { ok, toApiErrorResponse, type ApiCallLogContext } from '@/lib/api/v1/respond';

export async function GET(request: Request) {
  const logCtx: ApiCallLogContext = {
    method: 'GET',
    route: '/api/v1/me',
    startedAt: Date.now(),
  };
  try {
    const ctx = await requireApiKey(request);
    logCtx.accountId = ctx.accountId;
    logCtx.keyId = ctx.keyId;
    const name = await getAccountName(ctx.accountId);
    return ok(
      {
        account: { id: ctx.accountId, name },
        key: { id: ctx.keyId, scopes: ctx.scopes },
      },
      200,
      logCtx
    );
  } catch (err) {
    return toApiErrorResponse(err, logCtx);
  }
}
