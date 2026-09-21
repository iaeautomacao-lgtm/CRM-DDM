// ============================================================
// Public API (v1) response envelope.
//
// Every `/api/v1/*` route speaks one shape so external integrators
// can write a single response parser:
//
//   success → { "data": <payload> }
//   failure → { "error": { "code": "<machine_code>", "message": "<human>" } }
//
// `code` is a stable, machine-matchable string (clients branch on
// it); `message` is human-facing and may be reworded freely. This is
// intentionally distinct from the internal `{ error: string }` shape
// used by the dashboard's own `/api/*` routes — the public contract
// is versioned and shouldn't inherit internal wording changes.
// ============================================================

import { NextResponse } from 'next/server';
import type { RateLimitResult } from '@/lib/rate-limit';
import { logPublicApiCall, type ApiCallLogContext } from './log';
export type { ApiCallLogContext } from './log';

/** Context for logging a request whose account/key is already known
 * at throw time (a valid key that failed the scope or rate-limit
 * check) — lets the eventual system_logs row carry account_id/key_id
 * even though the throwing route's own ApiCallLogContext never got
 * populated (requireApiKey() threw before returning). */
export interface ApiErrorAccountContext {
  accountId?: string | null;
  keyId?: string | null;
}

export type ApiErrorCode =
  | 'unauthorized' // missing / malformed / unknown / revoked / expired key
  | 'forbidden' // valid key, but missing the required scope
  | 'rate_limited' // per-key budget exhausted
  | 'bad_request' // malformed input
  | 'not_found'
  | 'internal';

/**
 * Typed error a route (or `requireApiKey`) can throw and have mapped
 * to the envelope by `toApiErrorResponse`. Carries an HTTP status, a
 * machine code, and optional extra headers (used for the rate-limit
 * `Retry-After` / `X-RateLimit-*` set).
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly headers?: Record<string, string>;
  /** Set only when the throw site already resolved a key (forbidden /
   * rate_limited) — null for unauthorized, where revealing whether a
   * key exists would leak information to a probe. */
  readonly accountId: string | null;
  readonly keyId: string | null;

  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    headers?: Record<string, string>,
    context?: ApiErrorAccountContext
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.headers = headers;
    this.accountId = context?.accountId ?? null;
    this.keyId = context?.keyId ?? null;
  }
}

/** 401 — no usable credential. */
export function unauthorized(message = 'Missing or invalid API key'): ApiError {
  return new ApiError('unauthorized', message, 401);
}

/** 403 — authenticated, but the key lacks the scope this route needs. */
export function forbidden(message: string, context?: ApiErrorAccountContext): ApiError {
  return new ApiError('forbidden', message, 403, undefined, context);
}

/** 400 — bad input. */
export function badRequest(message: string): ApiError {
  return new ApiError('bad_request', message, 400);
}

/** 404 — no such resource, or it exists but belongs to another
 * account (deliberately indistinguishable on the wire). */
export function notFound(message: string): ApiError {
  return new ApiError('not_found', message, 404);
}

/** 429 — built from a `checkRateLimit` miss, with the standard headers. */
export function rateLimited(result: RateLimitResult, context?: ApiErrorAccountContext): ApiError {
  const retryAfter = Math.max(1, Math.ceil((result.reset - Date.now()) / 1000));
  return new ApiError(
    'rate_limited',
    'Rate limit exceeded for this API key',
    429,
    {
      'Retry-After': String(retryAfter),
      'X-RateLimit-Limit': String(result.limit),
      'X-RateLimit-Remaining': String(result.remaining),
      'X-RateLimit-Reset': String(Math.ceil(result.reset / 1000)),
    },
    context
  );
}

/** Success envelope: `{ data: <payload> }`. Pass `logCtx` (built right
 * after `requireApiKey()` succeeds) to record the call in system_logs;
 * omit it for internal helpers that reuse this envelope but aren't a
 * public-API route. */
export function ok<T>(data: T, status = 200, logCtx?: ApiCallLogContext): NextResponse {
  if (logCtx) logPublicApiCall(logCtx, status, null);
  return NextResponse.json({ data }, { status });
}

/**
 * Map any thrown value to the failure envelope. `ApiError` keeps its
 * code/status/headers; anything else collapses to a generic 500 so we
 * never leak internal error text onto the public wire.
 *
 * Pass `logCtx` to record the call in system_logs. When the error is
 * an `ApiError` carrying its own accountId/keyId (forbidden/
 * rate_limited, thrown before the route had a ctx to build logCtx
 * from), that takes precedence over logCtx's — see ApiError.accountId.
 */
export function toApiErrorResponse(err: unknown, logCtx?: ApiCallLogContext): NextResponse {
  if (err instanceof ApiError) {
    if (logCtx) {
      logPublicApiCall(
        {
          ...logCtx,
          accountId: err.accountId ?? logCtx.accountId,
          keyId: err.keyId ?? logCtx.keyId,
        },
        err.status,
        err.code
      );
    }
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: err.status, headers: err.headers }
    );
  }
  console.error('[api/v1] uncategorized error:', err);
  if (logCtx) logPublicApiCall(logCtx, 500, 'internal');
  return NextResponse.json(
    { error: { code: 'internal', message: 'Internal server error' } },
    { status: 500 }
  );
}
